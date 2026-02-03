const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { BedrockAgentRuntimeClient, RetrieveCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const { BedrockRuntimeClient, ApplyGuardrailCommand, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
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

// Step 1: Retrieve relevant chunks from Knowledge Base with confidence scores
async function retrieveFromKnowledgeBase(question) {
  console.log('=== STEP 1: RETRIEVING FROM KNOWLEDGE BASE ===');
  console.log('Question:', question);
  console.log('Knowledge Base ID:', KNOWLEDGE_BASE_ID);

  const params = {
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    retrievalQuery: {
      text: question,
    },
    retrievalConfiguration: {
      vectorSearchConfiguration: {
        numberOfResults: 5,
      },
    },
  };

  try {
    const response = await bedrockAgentClient.send(new RetrieveCommand(params));
    
    console.log('Retrieve response received:', {
      resultsCount: response.retrievalResults?.length || 0,
    });

    // Extract results with confidence scores
    const results = response.retrievalResults?.map((result, index) => {
      console.log(`Result ${index + 1}:`, {
        score: result.score,
        scoreType: typeof result.score,
        location: result.location?.s3Location?.uri || result.location?.webLocation?.url || 'Unknown',
        contentPreview: result.content?.text?.substring(0, 200) + '...',
      });

      return {
        id: index + 1,
        content: result.content?.text || '',
        source: result.location?.webLocation?.url || 
                result.location?.s3Location?.uri || 
                'Unknown source',
        score: result.score || 0,
      };
    }) || [];

    // Log all scores for debugging
    console.log('=== CONFIDENCE SCORES FROM RETRIEVE ===');
    results.forEach((r, i) => {
      console.log(`  Result ${i + 1}: score=${r.score}, source=${r.source.substring(0, 60)}...`);
    });
    
    const maxScore = results.length > 0 ? Math.max(...results.map(r => r.score)) : 0;
    console.log('Maximum confidence score:', maxScore);
    console.log('=== END RETRIEVE ===');

    return results;
  } catch (error) {
    console.error('Retrieve error:', {
      errorName: error.name,
      errorMessage: error.message,
      errorCode: error.$metadata?.httpStatusCode,
    });
    throw error;
  }
}

// Step 2: Generate answer using retrieved context
async function generateAnswer(question, retrievedResults) {
  console.log('=== STEP 2: GENERATING ANSWER ===');
  
  // Build context from retrieved results
  const context = retrievedResults
    .map((r, i) => `[Source ${i + 1}]: ${r.content}`)
    .join('\n\n');

  const prompt = `You are AskUSDA, a helpful assistant for the United States Department of Agriculture. 
Answer the user's question based ONLY on the provided context. If the context doesn't contain enough information to answer the question, say so.
Be concise, accurate, and helpful. Format your response using markdown when appropriate.

Context:
${context}

User Question: ${question}

Answer:`;

  console.log('Prompt length:', prompt.length);

  // Use Amazon Nova Pro model
  const modelId = 'amazon.nova-pro-v1:0';
  
  const requestBody = {
    messages: [
      {
        role: 'user',
        content: [{ text: prompt }],
      },
    ],
    inferenceConfig: {
      maxTokens: 2048,
      temperature: 0.7,
      topP: 0.9,
    },
  };

  try {
    const response = await bedrockRuntimeClient.send(new InvokeModelCommand({
      modelId: modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(requestBody),
    }));

    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const answer = responseBody.output?.message?.content?.[0]?.text || 
                   responseBody.content?.[0]?.text ||
                   "I couldn't generate a response. Please try again.";

    console.log('Generated answer length:', answer.length);
    console.log('=== END GENERATION ===');

    return answer;
  } catch (error) {
    console.error('Generation error:', {
      errorName: error.name,
      errorMessage: error.message,
    });
    throw error;
  }
}

// Combined: Query Knowledge Base with two-step approach
async function queryKnowledgeBase(question, sessionId) {
  const startTime = Date.now();

  // Step 1: Retrieve with confidence scores
  const retrievedResults = await retrieveFromKnowledgeBase(question);
  
  // Calculate max confidence score
  const maxConfidence = retrievedResults.length > 0 
    ? Math.max(...retrievedResults.map(r => r.score)) 
    : 0;

  console.log('=== CONFIDENCE CHECK ===');
  console.log('Max confidence score:', maxConfidence);
  console.log('Threshold: 0.8');
  console.log('Passes threshold:', maxConfidence >= 0.8);
  console.log('========================');

  // If confidence is too low, don't generate - return early
  if (maxConfidence < 0.8) {
    const responseTimeMs = Date.now() - startTime;
    return {
      answer: null,
      citations: retrievedResults.map(r => ({
        id: r.id,
        text: r.content.substring(0, 200),
        source: r.source,
        score: r.score,
      })),
      maxConfidence,
      responseTimeMs,
      lowConfidence: true,
    };
  }

  // Step 2: Generate answer using retrieved context
  const answer = await generateAnswer(question, retrievedResults);
  const responseTimeMs = Date.now() - startTime;

  // Build citations from retrieved results
  const citations = retrievedResults.map(r => ({
    id: r.id,
    text: r.content.substring(0, 200),
    source: r.source,
    score: r.score,
  }));

  return {
    answer,
    citations,
    maxConfidence,
    sessionId: sessionId || uuidv4(), // Generate new session ID if not provided
    responseTimeMs,
    lowConfidence: false,
  };
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

    // Detailed confidence logging for manual verification
    console.log('=== FINAL CONFIDENCE SCORE CHECK ===');
    console.log('User Question:', message);
    console.log('Number of citations:', result.citations.length);
    console.log('Individual citation scores:', result.citations.map((c, i) => ({
      citation: i + 1,
      score: c.score,
      source: c.source?.substring(0, 80) + '...'
    })));
    console.log('Maximum confidence score:', result.maxConfidence);
    console.log('Threshold:', 0.8);
    console.log('Is high confidence (>= 0.8)?:', result.maxConfidence >= 0.8);
    console.log('Decision:', result.lowConfidence ? 'SHOW LOW CONFIDENCE MESSAGE' : 'SHOW RESPONSE');
    console.log('=== END FINAL CHECK ===');

    if (result.lowConfidence) {
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
        maxConfidence: result.maxConfidence, // Send to frontend for logging
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
        question: message,
        maxConfidence: result.maxConfidence, // Send to frontend for logging
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
