const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
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
  
  console.log('Sending to client, endpoint:', endpoint, 'connectionId:', connectionId);
  
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
    if (error.statusCode === 410) {
      console.log('Client disconnected');
    }
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

// Query Knowledge Base
async function queryKnowledgeBase(question, sessionId) {
  const startTime = Date.now();
  
  // Get region from environment
  const region = process.env.AWS_REGION || 'us-west-2';
  
  // Use Amazon Nova Pro via inference profile
  const modelArn = `arn:aws:bedrock:${region}:${process.env.AWS_ACCOUNT_ID}:inference-profile/us.amazon.nova-pro-v1:0`;
  
  console.log('Using model ARN:', modelArn);
  console.log('Knowledge Base ID:', KNOWLEDGE_BASE_ID);
  
  const params = {
    input: { text: question },
    retrieveAndGenerateConfiguration: {
      type: 'KNOWLEDGE_BASE',
      knowledgeBaseConfiguration: {
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        modelArn: modelArn,
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: 5,
          },
        },
        generationConfiguration: {
          inferenceConfig: {
            textInferenceConfig: {
              maxTokens: 2048,
              temperature: 0.7,
              topP: 0.9,
            },
          },
        },
      },
    },
  };

  if (sessionId) {
    params.sessionId = sessionId;
  }

  try {
    const response = await bedrockAgentClient.send(new RetrieveAndGenerateCommand(params));
    const responseTimeMs = Date.now() - startTime;

    console.log('Knowledge Base response received:', {
      hasOutput: !!response.output?.text,
      citationsCount: response.citations?.length || 0,
      responseTimeMs,
    });

    // Detailed logging for confidence score debugging
    console.log('=== CONFIDENCE SCORE DEBUG START ===');
    console.log('Full citations array:', JSON.stringify(response.citations, null, 2));
    
    if (response.citations && response.citations.length > 0) {
      response.citations.forEach((citation, citationIndex) => {
        console.log(`Citation ${citationIndex}:`, {
          generatedResponsePartText: citation.generatedResponsePart?.textResponsePart?.text?.substring(0, 100) + '...',
          retrievedReferencesCount: citation.retrievedReferences?.length || 0,
        });
        
        if (citation.retrievedReferences && citation.retrievedReferences.length > 0) {
          citation.retrievedReferences.forEach((ref, refIndex) => {
            console.log(`  Reference ${refIndex}:`, {
              score: ref.score,
              scoreType: typeof ref.score,
              hasLocation: !!ref.location,
              locationType: ref.location?.type,
              s3Uri: ref.location?.s3Location?.uri,
              webUrl: ref.location?.webLocation?.url,
              // Log the entire reference object to see all available fields
              fullReference: JSON.stringify(ref, null, 2),
            });
          });
        } else {
          console.log('  No retrieved references for this citation');
        }
      });
    } else {
      console.log('No citations in response');
    }
    console.log('=== CONFIDENCE SCORE DEBUG END ===');

    // Extract citations - collect ALL scores from all references for better confidence calculation
    const citations = response.citations?.map((citation, index) => {
      // Get all scores from all retrieved references for this citation
      const allScores = citation.retrievedReferences?.map(ref => ref.score).filter(s => s !== undefined) || [];
      const maxScoreForCitation = allScores.length > 0 ? Math.max(...allScores) : 0;
      
      console.log(`Citation ${index} scores:`, {
        allScores,
        maxScoreForCitation,
        firstRefScore: citation.retrievedReferences?.[0]?.score,
      });
      
      return {
        id: index + 1,
        text: citation.generatedResponsePart?.textResponsePart?.text || '',
        source: citation.retrievedReferences?.[0]?.location?.webLocation?.url || 
                citation.retrievedReferences?.[0]?.location?.s3Location?.uri || 
                'Unknown source',
        score: maxScoreForCitation, // Use max score from all references
      };
    }) || [];
    
    // Log final extracted citations with scores
    console.log('Final extracted citations with scores:', citations.map(c => ({
      id: c.id,
      score: c.score,
      source: c.source.substring(0, 50) + '...',
    })));
    
    const overallMaxScore = citations.length > 0 ? Math.max(...citations.map(c => c.score)) : 0;
    console.log('Overall max confidence score:', overallMaxScore, 'Threshold for high confidence: 0.5');

    return {
      answer: response.output?.text || "I couldn't find relevant information about that topic. Please try asking about USDA programs, farm loans, conservation, or other agricultural services.",
      citations,
      sessionId: response.sessionId,
      responseTimeMs,
    };
  } catch (error) {
    console.error('Knowledge Base query error:', {
      errorName: error.name,
      errorMessage: error.message,
      errorCode: error.$metadata?.httpStatusCode,
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
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

    // Query Knowledge Base
    const result = await queryKnowledgeBase(message, sessionId);
    
    // Generate conversation ID (but don't save yet - only save when feedback is given)
    const conversationId = uuidv4();

    // Check confidence level - if below 0.8, return a low confidence message
    const maxConfidence = result.citations.length > 0 
      ? Math.max(...result.citations.map(c => c.score || 0)) 
      : 0;
    
    // Detailed confidence logging for manual verification
    console.log('=== CONFIDENCE SCORE CHECK ===');
    console.log('User Question:', message);
    console.log('Number of citations:', result.citations.length);
    console.log('Individual citation scores:', result.citations.map((c, i) => ({
      citation: i + 1,
      score: c.score,
      source: c.source?.substring(0, 80) + '...'
    })));
    console.log('Maximum confidence score:', maxConfidence);
    console.log('Threshold:', 0.8);
    console.log('Is high confidence (>= 0.8)?:', maxConfidence >= 0.8);
    console.log('Decision:', maxConfidence >= 0.8 ? 'SHOW RESPONSE' : 'SHOW LOW CONFIDENCE MESSAGE');
    console.log('=== END CONFIDENCE CHECK ===');

    if (maxConfidence < 0.8) {
      // Low confidence - suggest user to visit usda.gov or contact support
      await sendToClient(connectionId, {
        type: 'message',
        message: "I'm not very confident about the answer to your question. For accurate information, I'd recommend visiting [usda.gov](https://www.usda.gov) or clicking the **Customer Support** button (headphone icon) in the top right corner to speak with a representative who can better assist you.",
        citations: [], // Don't show citations for low confidence responses
        conversationId,
        sessionId: result.sessionId,
        responseTimeMs: result.responseTimeMs,
        question: message,
        lowConfidence: true,
      });
    } else {
      // High confidence - send the actual response
      await sendToClient(connectionId, {
        type: 'message',
        message: result.answer,
        citations: result.citations,
        conversationId,
        sessionId: result.sessionId,
        responseTimeMs: result.responseTimeMs,
        // Include data needed for saving conversation when feedback is submitted
        question: message,
      });
    }

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
  console.log('Event:', JSON.stringify(event, null, 2));

  const { requestContext, body } = event;
  const { connectionId, routeKey } = requestContext;

  try {
    switch (routeKey) {
      case '$connect':
        console.log('Client connected:', connectionId);
        return { statusCode: 200, body: 'Connected' };

      case '$disconnect':
        console.log('Client disconnected:', connectionId);
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
