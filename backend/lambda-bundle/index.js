/**
 * AskUSDA WebSocket Handler
 * 
 * Handles WebSocket connections for the AskUSDA chatbot.
 * Uses Bedrock Knowledge Base for RAG and Nova Pro for responses.
 */

const {
  BedrockRuntimeClient,
  ApplyGuardrailCommand,
  ConverseStreamCommand,
} = require('@aws-sdk/client-bedrock-runtime');
const {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
  RetrieveCommand,
} = require('@aws-sdk/client-bedrock-agent-runtime');
const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} = require('@aws-sdk/client-apigatewaymanagementapi');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

// Initialize clients
const bedrockRuntime = new BedrockRuntimeClient();
const bedrockAgent = new BedrockAgentRuntimeClient();
const dynamoClient = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(dynamoClient);

// Environment variables
const {
  CONVERSATION_TABLE,
  KNOWLEDGE_BASE_ID,
  BEDROCK_MODEL_ID,
  WEBSOCKET_ENDPOINT,
  GUARDRAIL_ID,
  GUARDRAIL_VERSION,
  AWS_REGION,
} = process.env;

// System prompt for the chatbot
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

function getApiGatewayClient() {
  const endpoint = WEBSOCKET_ENDPOINT.replace('wss://', 'https://');
  return new ApiGatewayManagementApiClient({ endpoint });
}

async function sendToClient(connectionId, payload) {
  const client = getApiGatewayClient();
  try {
    await client.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify(payload),
    }));
    return true;
  } catch (error) {
    if (error.statusCode === 410 || error.name === 'GoneException') {
      console.log(`Connection ${connectionId} is stale`);
      return false;
    }
    throw error;
  }
}

async function streamToClient(connectionId, chunk, isComplete = false) {
  return sendToClient(connectionId, { type: 'stream', chunk, isComplete });
}

// ==================== DynamoDB Operations ====================

async function saveConnection(connectionId) {
  const timestamp = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 86400; // 24 hour TTL
  
  await docClient.send(new PutCommand({
    TableName: CONVERSATION_TABLE,
    Item: { connectionId, timestamp, sessionId: connectionId, role: 'system', content: 'connected', ttl },
  }));
}

async function saveMessage(connectionId, role, content, metadata = {}) {
  const timestamp = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 86400 * 30; // 30 days
  
  await docClient.send(new PutCommand({
    TableName: CONVERSATION_TABLE,
    Item: { connectionId, timestamp, sessionId: connectionId, role, content, ttl, ...metadata },
  }));
}

async function getConversationHistory(connectionId, limit = 10) {
  const result = await docClient.send(new QueryCommand({
    TableName: CONVERSATION_TABLE,
    KeyConditionExpression: 'connectionId = :cid',
    ExpressionAttributeValues: { ':cid': connectionId },
    ScanIndexForward: false,
    Limit: limit,
  }));
  
  return (result.Items || [])
    .filter(item => item.role === 'user' || item.role === 'assistant')
    .reverse()
    .map(item => ({ role: item.role, content: [{ text: item.content }] }));
}


// ==================== Guardrail Functions ====================

async function applyGuardrail(text, source) {
  if (!GUARDRAIL_ID || !GUARDRAIL_VERSION) {
    return { blocked: false, text };
  }
  
  try {
    const response = await bedrockRuntime.send(new ApplyGuardrailCommand({
      guardrailIdentifier: GUARDRAIL_ID,
      guardrailVersion: GUARDRAIL_VERSION,
      source,
      content: [{ text: { text } }],
    }));
    
    if (response.action === 'GUARDRAIL_INTERVENED') {
      const blockedMessage = response.outputs?.[0]?.text || 
        'I cannot process this request due to content policy restrictions.';
      console.log(`Guardrail blocked ${source}:`, text.substring(0, 100));
      return { blocked: true, text: blockedMessage };
    }
    
    return { blocked: false, text };
  } catch (error) {
    console.error('Guardrail error:', error);
    return { blocked: false, text }; // Fail open
  }
}

// ==================== Knowledge Base Functions ====================

async function retrieveFromKnowledgeBase(query, maxResults = 5) {
  try {
    const response = await bedrockAgent.send(new RetrieveCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      retrievalQuery: { text: query },
      retrievalConfiguration: {
        vectorSearchConfiguration: { numberOfResults: maxResults },
      },
    }));
    return response.retrievalResults || [];
  } catch (error) {
    console.error('Knowledge Base retrieve error:', error);
    return [];
  }
}

function formatCitations(retrievalResults) {
  return retrievalResults
    .filter(result => result.score > 0.5)
    .map((result, index) => ({
      id: index + 1,
      text: result.content?.text?.substring(0, 200) + '...',
      source: result.location?.webLocation?.url || 
              result.location?.s3Location?.uri || 
              'USDA Knowledge Base',
      score: result.score,
    }));
}

function buildContextFromRetrieval(retrievalResults) {
  if (!retrievalResults.length) return '';
  
  return retrievalResults
    .filter(result => result.score > 0.3)
    .map((result, i) => `[Source ${i + 1}]: ${result.content?.text || ''}`)
    .join('\n\n');
}


// ==================== Bedrock Model Functions ====================

async function generateStreamingResponse(connectionId, userMessage, context, conversationHistory) {
  const modelId = BEDROCK_MODEL_ID;
  
  // Build system prompt with context if available
  let systemPrompt = SYSTEM_PROMPT;
  if (context) {
    systemPrompt = `${SYSTEM_PROMPT}

Use the following information from USDA sources to answer the user's question. If the context doesn't contain relevant information, say so clearly.

Context:
${context}`;
  }
  
  // Keep user message clean - exactly what the user typed
  const messages = [
    ...conversationHistory.slice(-6),
    { role: 'user', content: [{ text: userMessage }] },
  ];
  
  const commandParams = {
    modelId,
    system: [{ text: systemPrompt }],
    messages,
    inferenceConfig: { maxTokens: 1024, temperature: 0.7, topP: 0.9 },
  };
  
  if (GUARDRAIL_ID && GUARDRAIL_VERSION) {
    commandParams.guardrailConfig = {
      guardrailIdentifier: GUARDRAIL_ID,
      guardrailVersion: GUARDRAIL_VERSION,
    };
  }
  
  try {
    const response = await bedrockRuntime.send(new ConverseStreamCommand(commandParams));
    
    let fullResponse = '';
    let isBlocked = false;
    
    for await (const event of response.stream) {
      if (event.contentBlockDelta?.delta?.text) {
        const chunk = event.contentBlockDelta.delta.text;
        fullResponse += chunk;
        await streamToClient(connectionId, chunk, false);
      }
      
      if (event.messageStop?.stopReason === 'guardrail_intervened') {
        isBlocked = true;
      }
      
      if (event.metadata?.usage) {
        console.log('Token usage:', event.metadata.usage);
      }
    }
    
    await streamToClient(connectionId, '', true);
    return { text: fullResponse, blocked: isBlocked };
  } catch (error) {
    console.error('Streaming error:', error);
    throw error;
  }
}

async function retrieveAndGenerate(query) {
  const commandParams = {
    input: { text: query },
    retrieveAndGenerateConfiguration: {
      type: 'KNOWLEDGE_BASE',
      knowledgeBaseConfiguration: {
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        modelArn: `arn:aws:bedrock:${AWS_REGION}::foundation-model/${BEDROCK_MODEL_ID}`,
        generationConfiguration: {
          promptTemplate: {
            textPromptTemplate: `${SYSTEM_PROMPT}

Context from USDA sources:
$search_results$

User question: $query$

Provide a helpful response based on the context above.`,
          },
        },
      },
    },
  };
  
  if (GUARDRAIL_ID && GUARDRAIL_VERSION) {
    commandParams.retrieveAndGenerateConfiguration.knowledgeBaseConfiguration.generationConfiguration.guardrailConfiguration = {
      guardrailId: GUARDRAIL_ID,
      guardrailVersion: GUARDRAIL_VERSION,
    };
  }
  
  const response = await bedrockAgent.send(new RetrieveAndGenerateCommand(commandParams));
  return {
    text: response.output?.text || 'I could not generate a response.',
    citations: response.citations || [],
  };
}


// ==================== Route Handlers ====================

async function handleConnect(connectionId) {
  console.log(`Client connected: ${connectionId}`);
  await saveConnection(connectionId);
  return { statusCode: 200, body: 'Connected' };
}

async function handleDisconnect(connectionId) {
  console.log(`Client disconnected: ${connectionId}`);
  return { statusCode: 200, body: 'Disconnected' };
}

async function handleSendMessage(connectionId, body) {
  let request;
  try {
    request = JSON.parse(body || '{}');
  } catch {
    await sendToClient(connectionId, { type: 'error', message: 'Invalid JSON format' });
    return { statusCode: 400, body: 'Invalid JSON' };
  }
  
  const { message, useStreaming = true } = request;
  
  if (!message || typeof message !== 'string' || !message.trim()) {
    await sendToClient(connectionId, { type: 'error', message: 'Please provide a message' });
    return { statusCode: 400, body: 'Empty message' };
  }
  
  const userMessage = message.trim();
  console.log(`Processing message from ${connectionId}: ${userMessage.substring(0, 50)}...`);
  
  try {
    // Step 1: Check input with guardrail
    const inputCheck = await applyGuardrail(userMessage, 'INPUT');
    if (inputCheck.blocked) {
      await sendToClient(connectionId, { type: 'response', message: inputCheck.text, blocked: true });
      await saveMessage(connectionId, 'user', userMessage, { blocked: true });
      await saveMessage(connectionId, 'assistant', inputCheck.text, { blocked: true });
      return { statusCode: 200, body: 'Blocked by guardrail' };
    }
    
    // Step 2: Save user message
    await saveMessage(connectionId, 'user', userMessage);
    
    // Step 3: Send typing indicator
    await sendToClient(connectionId, { type: 'typing', status: true });
    
    // Step 4: Retrieve context from Knowledge Base
    const retrievalResults = await retrieveFromKnowledgeBase(userMessage);
    const context = buildContextFromRetrieval(retrievalResults);
    const citations = formatCitations(retrievalResults);
    
    // Step 5: Get conversation history
    const history = await getConversationHistory(connectionId);
    
    // Step 6: Generate response
    let responseText;
    let wasBlocked = false;
    
    if (useStreaming) {
      const result = await generateStreamingResponse(connectionId, userMessage, context, history);
      responseText = result.text;
      wasBlocked = result.blocked;
    } else {
      const result = await retrieveAndGenerate(userMessage);
      responseText = result.text;
      await sendToClient(connectionId, { type: 'response', message: responseText, citations: result.citations });
    }
    
    // Step 7: Check output with guardrail (non-streaming only)
    if (!useStreaming) {
      const outputCheck = await applyGuardrail(responseText, 'OUTPUT');
      if (outputCheck.blocked) {
        responseText = outputCheck.text;
        wasBlocked = true;
      }
    }
    
    // Step 8: Save assistant response
    await saveMessage(connectionId, 'assistant', responseText, {
      citations: JSON.stringify(citations),
      blocked: wasBlocked,
    });
    
    // Step 9: Send final response with citations (streaming only)
    if (useStreaming) {
      await sendToClient(connectionId, { type: 'response', message: responseText, citations, blocked: wasBlocked });
    }
    
    await sendToClient(connectionId, { type: 'typing', status: false });
    return { statusCode: 200, body: 'Success' };
    
  } catch (error) {
    console.error('Error in handleSendMessage:', error);
    await sendToClient(connectionId, {
      type: 'error',
      message: 'Sorry, I encountered an error processing your request. Please try again.',
    });
    await sendToClient(connectionId, { type: 'typing', status: false });
    return { statusCode: 500, body: 'Internal error' };
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
        return handleConnect(connectionId);
      case '$disconnect':
        return handleDisconnect(connectionId);
      case 'sendMessage':
      case '$default':
        return handleSendMessage(connectionId, body);
      default:
        console.warn(`Unknown route: ${routeKey}`);
        return { statusCode: 400, body: `Unknown route: ${routeKey}` };
    }
  } catch (error) {
    console.error(`Unhandled error in ${routeKey}:`, error);
    return { statusCode: 500, body: 'Internal server error' };
  }
};
