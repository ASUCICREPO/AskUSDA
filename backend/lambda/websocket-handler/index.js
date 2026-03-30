const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { BedrockAgentRuntimeClient, RetrieveAndGenerateCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const { BedrockRuntimeClient, ApplyGuardrailCommand } = require('@aws-sdk/client-bedrock-runtime');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const { v4: uuidv4 } = require('uuid');

// Initialize clients
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const bedrockAgentClient = new BedrockAgentRuntimeClient({});
const bedrockRuntimeClient = new BedrockRuntimeClient({});

// Environment variables
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID;
const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE;
const ESCALATION_TABLE = process.env.ESCALATION_TABLE;
const GUARDRAIL_ID = process.env.GUARDRAIL_ID;
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION || 'DRAFT';
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT;

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

    // Extract citations from the response
    const citations = [];
    if (response.citations) {
      for (const citation of response.citations) {
        for (const ref of (citation.retrievedReferences || [])) {
          const source = ref.location?.webLocation?.url ||
                         ref.location?.s3Location?.uri ||
                         'Unknown source';
          // Avoid duplicate sources
          if (!citations.find(c => c.source === source)) {
            citations.push({
              id: citations.length + 1,
              text: (ref.content?.text || '').substring(0, 200),
              source: source,
              score: 0,
            });
          }
        }
      }
    }

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
      maxConfidence: 0,
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
