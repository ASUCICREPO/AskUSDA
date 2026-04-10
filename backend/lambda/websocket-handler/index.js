const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { BedrockAgentRuntimeClient, RetrieveAndGenerateCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const { BedrockRuntimeClient, ApplyGuardrailCommand } = require('@aws-sdk/client-bedrock-runtime');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');

// Initialize clients
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const bedrockAgentClient = new BedrockAgentRuntimeClient({});
const bedrockRuntimeClient = new BedrockRuntimeClient({});
const s3Client = new S3Client({ region: process.env.CRAWLER_REGION || 'us-west-2' });

// Environment variables
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID;
const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE;
const ESCALATION_TABLE = process.env.ESCALATION_TABLE;
const GUARDRAIL_ID = process.env.GUARDRAIL_ID;
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION || 'DRAFT';
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT;
const CRAWLER_BUCKET = process.env.CRAWLER_BUCKET;

// Resolve a real website URL from an S3 URI by reading the crawler metadata file.
// Works for all content types: markdown, pdfs, and docs.
// Ingestion path: s3://bucket/ingestion/{type}/{filename}
// Crawler metadata paths:
//   jobs/{id}/all/metadata/{hash}.md.metadata.json  (for markdown)
//   jobs/{id}/pdfs/metadata/{name}.pdf.metadata.json (for pdfs)
//   jobs/{id}/docs/metadata/{name}.xlsx.metadata.json (for docs)
async function resolveSourceUrl(s3Uri) {
  if (!CRAWLER_BUCKET || !s3Uri.includes(CRAWLER_BUCKET)) return s3Uri;
  try {
    const key = s3Uri.replace(`s3://${CRAWLER_BUCKET}/`, '');

    // If the file is in ingestion/, try to read the co-located Bedrock metadata
    if (key.startsWith('ingestion/')) {
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

    // Fallback: try the original crawler metadata paths under jobs/
    // For markdown: jobs/{id}/all/markdown/{hash}.md → jobs/{id}/all/metadata/{hash}.md.metadata.json
    // For pdfs:     jobs/{id}/pdfs/{name}.pdf → jobs/{id}/pdfs/metadata/{name}.pdf.metadata.json
    // For docs:     jobs/{id}/docs/{name}.xlsx → jobs/{id}/docs/metadata/{name}.xlsx.metadata.json
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

// Helper to send message to WebSocket client
async function sendToClient(connectionId, data) {
  // The WEBSOCKET_ENDPOINT is the callback URL which already includes the stage
  // Format: https://{api-id}.execute-api.{region}.amazonaws.com/{stage}
  const endpoint = WEBSOCKET_ENDPOINT.replace('wss://', 'https://');
  
  const apiGatewayClient = new ApiGatewayManagementApiClient({
    endpoint: endpoint,
  });

  try {
    await apiGatewayClient.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify(data),
    }));
  } catch (error) {
    console.error('Error sending to client:', error);
    throw error;
  }
}

// Apply guardrails to input
async function applyGuardrails(text) {
  if (!GUARDRAIL_ID) {
    return { blocked: false, text };
  }

  try {
    const response = await bedrockRuntimeClient.send(new ApplyGuardrailCommand({
      guardrailIdentifier: GUARDRAIL_ID,
      guardrailVersion: GUARDRAIL_VERSION,
      source: 'INPUT',
      content: [{ text: { text } }],
    }));

    if (response.action === 'GUARDRAIL_INTERVENED') {
      return {
        blocked: true,
        message: response.outputs?.[0]?.text || "I'm sorry, but I can't help with that request. Please ask about USDA programs and services.",
      };
    }

    return { blocked: false, text };
  } catch (error) {
    console.error('Guardrail error:', error);
    return { blocked: false, text };
  }
}

// Query Knowledge Base using RetrieveAndGenerate API (matches console behavior)
async function queryKnowledgeBase(question, sessionId) {
  const startTime = Date.now();
  console.log('[PIPELINE] Starting RetrieveAndGenerate for question:', question);

  const modelArn = `arn:aws:bedrock:${process.env.AWS_REGION}:${process.env.AWS_ACCOUNT_ID}:inference-profile/us.amazon.nova-pro-v1:0`;

  const params = {
    input: { text: question },
    retrieveAndGenerateConfiguration: {
      type: 'KNOWLEDGE_BASE',
      knowledgeBaseConfiguration: {
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        modelArn: modelArn,
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: 100,
            overrideSearchType: 'HYBRID',
            rerankingConfiguration: {
              type: 'BEDROCK_RERANKING_MODEL',
              bedrockRerankingConfiguration: {
                modelConfiguration: {
                  modelArn: `arn:aws:bedrock:${process.env.AWS_REGION}::foundation-model/amazon.rerank-v1:0`,
                },
              },
            },
          },
        },
      },
    },
  };

  try {
    const response = await bedrockAgentClient.send(new RetrieveAndGenerateCommand(params));
    const responseTimeMs = Date.now() - startTime;

    const answer = response.output?.text || "I couldn't generate a response. Please try again.";

    // Extract citations from the RetrieveAndGenerate response — these are the
    // exact sources the model used to generate the answer.
    // Priority: metadata.source_url > webLocation > s3Location (with S3 fallback)
    const rawCitations = [];
    const seen = new Set();
    if (response.citations) {
      for (const citation of response.citations) {
        for (const ref of (citation.retrievedReferences || [])) {
          const metadata = ref.metadata || {};
          const sourceUrl = metadata.source_url || metadata['source_url'] || '';
          const webUrl = ref.location?.webLocation?.url || '';
          const s3Uri = ref.location?.s3Location?.uri || '';
          const source = sourceUrl || webUrl || s3Uri || '';
          const title = metadata.title || '';

          if (source && !seen.has(source)) {
            seen.add(source);
            rawCitations.push({
              text: (ref.content?.text || '').substring(0, 200),
              source,
              title,
              needsResolve: !sourceUrl && !webUrl && !!s3Uri,
            });
          }
        }
      }
    }

    // Fallback: resolve S3 URIs to real URLs by reading crawler metadata from S3
    const resolved = await Promise.all(rawCitations.map(async (r) => {
      if (r.needsResolve) {
        const realUrl = await resolveSourceUrl(r.source);
        return { ...r, source: realUrl };
      }
      return r;
    }));

    // Deduplicate after resolution (two S3 URIs might map to the same URL)
    const citations = [];
    const finalSeen = new Set();
    for (const r of resolved) {
      if (!finalSeen.has(r.source)) {
        finalSeen.add(r.source);
        citations.push({
          id: citations.length + 1,
          text: r.text,
          source: r.source,
          title: r.title,
          score: 0,
        });
      }
    }

    const maxConfidence = 0;

    console.log('[PIPELINE] Complete:', {
      question,
      totalMs: responseTimeMs,
      answerLength: answer.length,
      citationCount: citations.length,
      sessionId: response.sessionId,
    });

    return {
      answer,
      citations,
      maxConfidence,
      sessionId: sessionId || uuidv4(),
      responseTimeMs,
    };
  } catch (error) {
    console.error('[PIPELINE] Error:', {
      errorName: error.name,
      errorMessage: error.message,
      errorCode: error.$metadata?.httpStatusCode,
    });
    throw error;
  }
}

// Save escalation request
async function saveEscalation(name, email, phone, question, sessionId) {
  const escalationId = uuidv4();
  const now = new Date();
  const timestamp = now.toISOString();
  const date = timestamp.split('T')[0]; // For GSI
  const ttl = Math.floor(now.getTime() / 1000) + (365 * 24 * 60 * 60); // 1 year TTL

  await docClient.send(new PutCommand({
    TableName: ESCALATION_TABLE,
    Item: {
      escalationId,
      timestamp,
      date,
      name,
      email,
      phone: phone || '',
      question,
      sessionId: sessionId || '',
      status: 'pending',
      ttl,
    },
  }));

  return escalationId;
}

// Handle sendMessage action
async function handleSendMessage(connectionId, body) {
  const { message, sessionId } = body;

  if (!message) {
    await sendToClient(connectionId, {
      type: 'error',
      message: 'Message is required',
    });
    return;
  }

  // Send typing indicator
  await sendToClient(connectionId, { type: 'typing', isTyping: true });

  try {
    // Apply guardrails
    const guardrailResult = await applyGuardrails(message);
    
    if (guardrailResult.blocked) {
      await sendToClient(connectionId, {
        type: 'message',
        message: guardrailResult.message,
        blocked: true,
      });
      return;
    }

    // Query Knowledge Base (two-step: retrieve + generate)
    const result = await queryKnowledgeBase(message, sessionId);
    
    // Generate conversation ID (but don't save yet - only save when feedback is given)
    const conversationId = uuidv4();

    await sendToClient(connectionId, {
      type: 'message',
      message: result.answer,
      citations: result.citations,
      conversationId,
      sessionId: result.sessionId,
      responseTimeMs: result.responseTimeMs,
      question: message,
      maxConfidence: result.maxConfidence,
    });

  } catch (error) {
    console.error('Error processing message:', error);
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('Knowledge Base ID:', KNOWLEDGE_BASE_ID);
    console.error('AWS Region:', process.env.AWS_REGION);
    
    // Provide more specific error messages based on error type
    let errorMessage = 'An error occurred while processing your request. Please try again.';
    if (error.name === 'AccessDeniedException') {
      errorMessage = 'Access denied. Please check model access permissions.';
    } else if (error.name === 'ResourceNotFoundException') {
      errorMessage = 'Knowledge base not found. Please verify configuration.';
    } else if (error.name === 'ValidationException') {
      errorMessage = 'Invalid request. ' + (error.message || '');
    } else if (error.name === 'ThrottlingException') {
      errorMessage = 'Service is busy. Please try again in a moment.';
    }
    
    await sendToClient(connectionId, {
      type: 'error',
      message: errorMessage,
    });
  }
}

// Handle submitFeedback action - saves conversation only when feedback is given
async function handleSubmitFeedback(connectionId, body) {
  const { conversationId, feedback, question, answer, sessionId, responseTimeMs, citations } = body;

  if (!conversationId || !feedback) {
    await sendToClient(connectionId, {
      type: 'error',
      message: 'conversationId and feedback are required',
    });
    return;
  }

  try {
    // Save the conversation with feedback (only conversations with feedback are stored)
    const now = new Date();
    const timestamp = now.toISOString();
    const date = timestamp.split('T')[0];
    const ttl = Math.floor(now.getTime() / 1000) + (90 * 24 * 60 * 60); // 90 days TTL

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
    
    await sendToClient(connectionId, {
      type: 'feedbackConfirmation',
      success: true,
      conversationId,
      feedback,
    });
  } catch (error) {
    console.error('Error saving feedback:', error);
    await sendToClient(connectionId, {
      type: 'error',
      message: 'Failed to save feedback',
    });
  }
}

// Handle submitEscalation action
async function handleSubmitEscalation(connectionId, body) {
  const { name, email, phone, question, sessionId } = body;

  if (!name || !email || !question) {
    await sendToClient(connectionId, {
      type: 'error',
      message: 'Name, email, and question are required',
    });
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
    await sendToClient(connectionId, {
      type: 'error',
      message: 'Failed to submit support request',
    });
  }
}

// Main handler
exports.handler = async (event) => {
  const { requestContext, body } = event;
  const { connectionId, routeKey } = requestContext;

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
      default:
        // Try to parse the body and route based on action
        const parsedBody = JSON.parse(body || '{}');
        const action = parsedBody.action;

        if (action === 'sendMessage') {
          await handleSendMessage(connectionId, parsedBody);
        } else if (action === 'submitFeedback') {
          await handleSubmitFeedback(connectionId, parsedBody);
        } else if (action === 'submitEscalation') {
          await handleSubmitEscalation(connectionId, parsedBody);
        } else {
          await sendToClient(connectionId, {
            type: 'error',
            message: `Unknown action: ${action || routeKey}`,
          });
        }
        break;
    }

    return { statusCode: 200, body: 'OK' };
  } catch (error) {
    console.error('Handler error:', error);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};
