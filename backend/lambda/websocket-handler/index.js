const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} = require('@aws-sdk/client-bedrock-agent-runtime');
const {
  BedrockRuntimeClient,
  ApplyGuardrailCommand,
  ConverseStreamCommand,
} = require('@aws-sdk/client-bedrock-runtime');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');

// Initialize clients once per cold start
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const bedrockAgent = new BedrockAgentRuntimeClient({});
const bedrockRuntime = new BedrockRuntimeClient({});
const s3Client = new S3Client({ region: process.env.CRAWLER_REGION || 'us-west-2' });

const {
  CONVERSATION_TABLE,
  ESCALATION_TABLE,
  KNOWLEDGE_BASE_ID,
  BEDROCK_MODEL_ID,
  WEBSOCKET_ENDPOINT,
  GUARDRAIL_ID,
  GUARDRAIL_VERSION = 'DRAFT',
  CRAWLER_BUCKET,
  AWS_REGION,
  AWS_ACCOUNT_ID,
} = process.env;

const SYSTEM_PROMPT = `You are AskUSDA, an official AI assistant for the United States Department of Agriculture, designed to serve farmers, ranchers, and the general public.

PURPOSE:
Your core mission is to reduce friction in navigating USDA services by answering inquiries strictly using indexed data from usda.gov and farmers.gov (including HTML pages and PDF documents).

STRICT SOURCING RULES:
- Every claim MUST be backed by a direct citation/link to the source material from the provided context
- If information is NOT in the knowledge base context provided, clearly state: "I don't have specific information about that in my knowledge base. Please visit usda.gov or contact your local USDA Service Center for assistance."
- NEVER fabricate, guess, or hallucinate information - accuracy is paramount over conversation flow
- When citing sources, include the specific URL when available

ACTION-ORIENTED RESPONSES:
- Direct users to the specific next step (e.g., "Apply here: [link]", "Visit this program page: [link]")
- Minimize clicks by providing direct paths to resources
- Include relevant phone numbers, office locations, or application links when available

CONFIDENCE HANDLING:
- HIGH CONFIDENCE: Provide the answer with source citations
- LOW CONFIDENCE: Respond with: "I'm not certain about this specific question. To ensure you get accurate information, I recommend contacting the USDA directly at 1-800-727-9540 or visiting ask.usda.gov to submit your question to a specialist."

SCOPE BOUNDARIES:
- Operate in English only
- Do not interpret audio/video content
- Do not attempt to access private internal systems or personal account information
- Focus only on publicly available USDA information

TOPICS YOU CAN HELP WITH:
- Agricultural programs and services
- Food safety and nutrition (FSIS, FDA coordination)
- Rural development programs and loans
- Conservation and environmental programs (NRCS, FSA)
- Farm loans, grants, and disaster assistance
- SNAP, WIC, and nutrition assistance programs
- USDA regulations and policies
- Crop insurance and risk management

RESPONSE FORMAT:
- Be concise but thorough
- Use bullet points for multiple items or steps
- Always end with a relevant next action or resource link when applicable`;

// ==================== WebSocket Utilities ====================

let _apiGwClient;
function getApiGatewayClient() {
  if (!_apiGwClient) {
    _apiGwClient = new ApiGatewayManagementApiClient({
      endpoint: WEBSOCKET_ENDPOINT.replace('wss://', 'https://'),
    });
  }
  return _apiGwClient;
}

async function sendToClient(connectionId, payload) {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await getApiGatewayClient().send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify(payload),
      }));
      return true;
    } catch (error) {
      if (error.statusCode === 410 || error.name === 'GoneException') {
        console.log(`Connection ${connectionId} is stale`);
        return false;
      }
      if (error.name === 'TooManyRequestsException' && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        continue;
      }
      console.error('Error sending to client:', error);
      throw error;
    }
  }
}

// ==================== Source URL Resolution ====================

async function resolveSourceUrl(s3Uri) {
  if (!CRAWLER_BUCKET || !s3Uri.includes(CRAWLER_BUCKET)) return s3Uri;
  try {
    const key = s3Uri.replace(`s3://${CRAWLER_BUCKET}/`, '');

    if (key.startsWith('ingestion')) {
      const bedrockMetaKey = key + '.metadata.json';
      try {
        const resp = await s3Client.send(new GetObjectCommand({ Bucket: CRAWLER_BUCKET, Key: bedrockMetaKey }));
        const chunks = [];
        for await (const chunk of resp.Body) chunks.push(chunk);
        const meta = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const url = meta.metadataAttributes?.source_url;
        if (url) return url;
      } catch {}
    }

    let metadataKey;
    if (key.includes('/all/markdown/')) {
      metadataKey = key.replace('/all/markdown/', '/all/metadata/') + '.metadata.json';
    } else if (key.includes('/pdfs/') && !key.includes('/metadata/')) {
      const parts = key.split('/pdfs/');
      metadataKey = parts[0] + '/pdfs/metadata/' + parts[1] + '.metadata.json';
    } else if (key.includes('/docs/') && !key.includes('/metadata/')) {
      const parts = key.split('/docs/');
      metadataKey = parts[0] + '/docs/metadata/' + parts[1] + '.metadata.json';
    }

    if (metadataKey) {
      const resp = await s3Client.send(new GetObjectCommand({ Bucket: CRAWLER_BUCKET, Key: metadataKey }));
      const chunks = [];
      for await (const chunk of resp.Body) chunks.push(chunk);
      const meta = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      return meta.source_url || s3Uri;
    }

    return s3Uri;
  } catch {
    return s3Uri;
  }
}

// ==================== Guardrail ====================

async function applyGuardrail(text) {
  if (!GUARDRAIL_ID) return { blocked: false };

  try {
    const response = await bedrockRuntime.send(new ApplyGuardrailCommand({
      guardrailIdentifier: GUARDRAIL_ID,
      guardrailVersion: GUARDRAIL_VERSION,
      source: 'INPUT',
      content: [{ text: { text } }],
    }));

    if (response.action === 'GUARDRAIL_INTERVENED') {
      return {
        blocked: true,
        message: response.outputs?.[0]?.text ||
          "I'm sorry, but I can't help with that request. Please ask about USDA programs and services.",
      };
    }
    return { blocked: false };
  } catch (error) {
    console.error('Guardrail error:', error);
    return { blocked: false };
  }
}

// ==================== Knowledge Base Retrieval ====================

async function retrieveFromKB(query) {
  const startTime = Date.now();
  const response = await bedrockAgent.send(new RetrieveCommand({
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    retrievalQuery: { text: query },
    retrievalConfiguration: {
      vectorSearchConfiguration: {
        numberOfResults: 25,
        rerankingConfiguration: {
          type: 'BEDROCK_RERANKING_MODEL',
          bedrockRerankingConfiguration: {
            modelConfiguration: {
              modelArn: `arn:aws:bedrock:${AWS_REGION}::foundation-model/amazon.rerank-v1:0`,
            },
          },
        },
      },
    },
  }));

  const retrieveMs = Date.now() - startTime;
  console.log(`[PIPELINE] Retrieve: ${retrieveMs}ms, ${(response.retrievalResults || []).length} results`);
  return response.retrievalResults || [];
}

function buildContext(results) {
  return results
    .filter(r => (r.score ?? 1) > 0.3)
    .map((r, i) => `[Source ${i + 1}]: ${r.content?.text || ''}`)
    .join('\n\n');
}

async function buildCitations(results) {
  const seen = new Set();
  const raw = [];

  for (const ref of results.filter(r => (r.score ?? 1) > 0.5)) {
    const metadata = ref.metadata || {};
    const sourceUrl = metadata.source_url || metadata['source_url'] || '';
    const webUrl = ref.location?.webLocation?.url || '';
    const s3Uri = ref.location?.s3Location?.uri || '';
    const source = sourceUrl || webUrl || s3Uri || '';
    const title = metadata.title || '';

    if (source && !seen.has(source)) {
      seen.add(source);
      raw.push({ source, title, text: (ref.content?.text || '').substring(0, 200), needsResolve: !sourceUrl && !webUrl && !!s3Uri });
    }
  }

  const resolved = await Promise.all(raw.map(async (r) => {
    if (r.needsResolve) {
      return { ...r, source: await resolveSourceUrl(r.source) };
    }
    return r;
  }));

  const finalSeen = new Set();
  const citations = [];
  for (const r of resolved) {
    if (!finalSeen.has(r.source)) {
      finalSeen.add(r.source);
      citations.push({ id: citations.length + 1, text: r.text, source: r.source, title: r.title, score: 0 });
    }
  }
  return citations;
}

// ==================== Streaming Generation ====================

async function streamResponse(connectionId, userMessage, context) {
  const modelArn = `arn:aws:bedrock:${AWS_REGION}:${AWS_ACCOUNT_ID}:inference-profile/us.amazon.nova-pro-v1:0`;

  let systemPrompt = SYSTEM_PROMPT;
  if (context) {
    systemPrompt += `\n\nUse the following information from USDA sources to answer the user's question. If the context doesn't contain relevant information, say so clearly.\n\nContext:\n${context}`;
  }

  const commandParams = {
    modelId: modelArn,
    system: [{ text: systemPrompt }],
    messages: [{ role: 'user', content: [{ text: userMessage }] }],
    inferenceConfig: { maxTokens: 1024, temperature: 0.3, topP: 0.9 },
  };

  if (GUARDRAIL_ID && GUARDRAIL_VERSION) {
    commandParams.guardrailConfig = {
      guardrailIdentifier: GUARDRAIL_ID,
      guardrailVersion: GUARDRAIL_VERSION,
    };
  }

  const response = await bedrockRuntime.send(new ConverseStreamCommand(commandParams));

  let fullResponse = '';
  let blocked = false;
  let chunkBuffer = '';
  let lastSendTime = Date.now();
  const FLUSH_INTERVAL_MS = 150;

  for await (const event of response.stream) {
    if (event.contentBlockDelta?.delta?.text) {
      const chunk = event.contentBlockDelta.delta.text;
      fullResponse += chunk;
      chunkBuffer += chunk;

      const now = Date.now();
      if (now - lastSendTime >= FLUSH_INTERVAL_MS || chunkBuffer.length > 200) {
        await sendToClient(connectionId, { type: 'stream', chunk: chunkBuffer, isComplete: false });
        chunkBuffer = '';
        lastSendTime = now;
      }
    }
    if (event.messageStop?.stopReason === 'guardrail_intervened') {
      blocked = true;
    }
    if (event.metadata?.usage) {
      console.log('Token usage:', event.metadata.usage);
    }
  }

  if (chunkBuffer) {
    await sendToClient(connectionId, { type: 'stream', chunk: chunkBuffer, isComplete: false });
  }

  await sendToClient(connectionId, { type: 'stream', chunk: '', isComplete: true });
  return { text: fullResponse, blocked };
}

// ==================== Escalation ====================

async function saveEscalation(name, email, phone, question, sessionId) {
  const escalationId = uuidv4();
  const now = new Date();
  const timestamp = now.toISOString();
  const date = timestamp.split('T')[0];
  const ttl = Math.floor(now.getTime() / 1000) + (365 * 24 * 60 * 60);

  await docClient.send(new PutCommand({
    TableName: ESCALATION_TABLE,
    Item: { escalationId, timestamp, date, name, email, phone: phone || '', question, sessionId: sessionId || '', status: 'pending', ttl },
  }));
  return escalationId;
}

// ==================== Route Handlers ====================

async function handleSendMessage(connectionId, body) {
  const { message, sessionId } = body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    await sendToClient(connectionId, { type: 'error', message: 'Message is required' });
    return;
  }

  const userMessage = message.trim();
  const startTime = Date.now();
  console.log(`[PIPELINE] Start: "${userMessage.substring(0, 60)}..."`);

  await sendToClient(connectionId, { type: 'typing', isTyping: true });

  try {
    const guardrailResult = await applyGuardrail(userMessage);
    if (guardrailResult.blocked) {
      await sendToClient(connectionId, { type: 'message', message: guardrailResult.message, blocked: true });
      await sendToClient(connectionId, { type: 'typing', isTyping: false });
      return;
    }

    // Retrieve from KB (this is fast — ~1-2s)
    const retrievalResults = await retrieveFromKB(userMessage);
    const context = buildContext(retrievalResults);

    // Build citations in parallel with the stream start
    const citationsPromise = buildCitations(retrievalResults);

    // Stream the response — user sees text appearing immediately
    const { text: responseText, blocked } = await streamResponse(connectionId, userMessage, context);

    const citations = await citationsPromise;
    const conversationId = uuidv4();
    const responseTimeMs = Date.now() - startTime;

    // Send final message with citations and metadata
    await sendToClient(connectionId, {
      type: 'message',
      message: responseText,
      citations,
      conversationId,
      sessionId: sessionId || conversationId,
      responseTimeMs,
      question: userMessage,
      blocked,
    });

    console.log(`[PIPELINE] Complete: ${responseTimeMs}ms, ${responseText.length} chars, ${citations.length} citations`);
  } catch (error) {
    console.error('[PIPELINE] Error:', { name: error.name, message: error.message, code: error.$metadata?.httpStatusCode });

    let errorMessage = 'An error occurred while processing your request. Please try again.';
    if (error.name === 'AccessDeniedException') errorMessage = 'Access denied. Please check model access permissions.';
    else if (error.name === 'ResourceNotFoundException') errorMessage = 'Knowledge base not found. Please verify configuration.';
    else if (error.name === 'ValidationException') errorMessage = 'Invalid request. ' + (error.message || '');
    else if (error.name === 'ThrottlingException') errorMessage = 'Service is busy. Please try again in a moment.';

    await sendToClient(connectionId, { type: 'error', message: errorMessage });
  } finally {
    await sendToClient(connectionId, { type: 'typing', isTyping: false });
  }
}

async function handleSubmitFeedback(connectionId, body) {
  const { conversationId, feedback, question, answer, sessionId, responseTimeMs, citations } = body;

  if (!conversationId || !feedback) {
    await sendToClient(connectionId, { type: 'error', message: 'conversationId and feedback are required' });
    return;
  }

  try {
    const now = new Date();
    const timestamp = now.toISOString();
    const date = timestamp.split('T')[0];
    const ttl = Math.floor(now.getTime() / 1000) + (90 * 24 * 60 * 60);

    await docClient.send(new PutCommand({
      TableName: CONVERSATION_TABLE,
      Item: {
        conversationId,
        timestamp,
        sessionId: sessionId || '',
        question: question || '',
        answer: answer || '',
        answerPreview: (answer || '').substring(0, 500),
        citations: JSON.stringify(citations || []),
        responseTimeMs: responseTimeMs || 0,
        date,
        feedback: feedback === 'positive' ? 'pos' : 'neg',
        feedbackTs: timestamp,
        ttl,
      },
    }));

    await sendToClient(connectionId, { type: 'feedbackConfirmation', success: true, conversationId, feedback });
  } catch (error) {
    console.error('Error saving feedback:', error);
    await sendToClient(connectionId, { type: 'error', message: 'Failed to save feedback' });
  }
}

async function handleSubmitEscalation(connectionId, body) {
  const { name, email, phone, question, sessionId } = body;

  if (!name || !email || !question) {
    await sendToClient(connectionId, { type: 'error', message: 'Name, email, and question are required' });
    return;
  }

  try {
    const escalationId = await saveEscalation(name, email, phone, question, sessionId);
    await sendToClient(connectionId, {
      type: 'escalationConfirmation',
      success: true,
      escalationId,
      message: 'Your support request has been submitted. Our team will contact you soon.',
    });
  } catch (error) {
    console.error('Error saving escalation:', error);
    await sendToClient(connectionId, { type: 'error', message: 'Failed to submit support request' });
  }
}

// ==================== Main Handler ====================

exports.handler = async (event) => {
  const { requestContext, body } = event;
  const { connectionId, routeKey } = requestContext;

  console.log(`[${routeKey}] Connection: ${connectionId}`);

  try {
    switch (routeKey) {
      case '$connect':
        return { statusCode: 200, body: 'Connected' };

      case '$disconnect':
        return { statusCode: 200, body: 'Disconnected' };

      case 'sendMessage':
        await handleSendMessage(connectionId, JSON.parse(body || '{}'));
        break;

      case 'submitFeedback':
        await handleSubmitFeedback(connectionId, JSON.parse(body || '{}'));
        break;

      case 'submitEscalation':
        await handleSubmitEscalation(connectionId, JSON.parse(body || '{}'));
        break;

      case '$default':
      default: {
        const parsedBody = JSON.parse(body || '{}');
        const action = parsedBody.action;
        if (action === 'sendMessage') await handleSendMessage(connectionId, parsedBody);
        else if (action === 'submitFeedback') await handleSubmitFeedback(connectionId, parsedBody);
        else if (action === 'submitEscalation') await handleSubmitEscalation(connectionId, parsedBody);
        else await sendToClient(connectionId, { type: 'error', message: `Unknown action: ${action || routeKey}` });
        break;
      }
    }

    return { statusCode: 200, body: 'OK' };
  } catch (error) {
    console.error(`Unhandled error in ${routeKey}:`, error);
    try {
      await sendToClient(connectionId, { type: 'typing', isTyping: false });
    } catch {}
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};
