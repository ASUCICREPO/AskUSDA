const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { BedrockAgentRuntimeClient, RetrieveCommand, RerankCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
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

// Step 1: Retrieve relevant chunks from Knowledge Base with confidence scores
async function retrieveFromKnowledgeBase(question) {
  const params = {
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    retrievalQuery: {
      text: question,
    },
    retrievalConfiguration: {
      vectorSearchConfiguration: {
        numberOfResults: 15, // Retrieve 15 results initially for re-ranking
        overrideSearchType: 'HYBRID', // Use hybrid search (vector + keyword) for better relevance
      },
    },
  };

  try {
    const retrieveStart = Date.now();
    const response = await bedrockAgentClient.send(new RetrieveCommand(params));

    // Extract results with confidence scores
    const results = response.retrievalResults?.map((result, index) => ({
      id: index + 1,
      content: result.content?.text || '',
      source: result.location?.webLocation?.url ||
              result.location?.s3Location?.uri ||
              'Unknown source',
      score: result.score || 0,
    })) || [];

    const retrieveMs = Date.now() - retrieveStart;
    console.log('[RETRIEVE] Completed:', {
      durationMs: retrieveMs,
      totalResults: results.length,
      scoreRange: results.length > 0
        ? { highest: results[0]?.score, lowest: results[results.length - 1]?.score }
        : null,
    });
    // Log all 30 retrieved chunks with source and score
    console.log('[RETRIEVE] All chunks:', JSON.stringify(results.map(r => ({
      id: r.id,
      score: r.score,
      source: r.source,
      preview: r.content.substring(0, 150),
    })), null, 2));

    return results;
  } catch (error) {
    console.error('[RETRIEVE] Error:', {
      errorName: error.name,
      errorMessage: error.message,
      errorCode: error.$metadata?.httpStatusCode,
    });
    throw error;
  }
}

// Step 1.5: Re-rank retrieved results using Amazon Rerank model
async function rerankResults(question, retrievedResults) {
  if (retrievedResults.length === 0) {
    return [];
  }

  try {
    // Prepare sources for re-ranking
    const sources = retrievedResults.map((result) => ({
      type: 'INLINE',
      inlineDocumentSource: {
        type: 'TEXT',
        textDocument: {
          text: result.content,
        },
      },
    }));

    const rerankParams = {
      queries: [
        {
          type: 'TEXT',
          textQuery: {
            text: question,
          },
        },
      ],
      sources: sources,
      rerankingConfiguration: {
        type: 'BEDROCK_RERANKING_MODEL',
        bedrockRerankingConfiguration: {
          modelConfiguration: {
            modelArn: `arn:aws:bedrock:${process.env.AWS_REGION}::foundation-model/amazon.rerank-v1:0`,
          },
          numberOfResults: 5, // Return top 5 after re-ranking
        },
      },
    };

    const rerankStart = Date.now();
    const response = await bedrockAgentClient.send(new RerankCommand(rerankParams));
    const rerankMs = Date.now() - rerankStart;

    // Map re-ranked results back to original results with new scores
    const rerankedResults = response.results?.map((result, newIndex) => {
      const originalIndex = result.index;
      const originalResult = retrievedResults[originalIndex];
      return {
        id: newIndex + 1,
        content: originalResult.content,
        source: originalResult.source,
        originalRank: originalIndex + 1,
        score: originalResult.score,
        rerankScore: result.relevanceScore,
      };
    }) || [];

    console.log('[RERANK] Completed:', {
      durationMs: rerankMs,
      originalCount: retrievedResults.length,
      rerankedCount: rerankedResults.length,
      topVectorScore: rerankedResults[0]?.score,
      topRerankScore: rerankedResults[0]?.rerankScore,
    });
    // Log all reranked results showing rank movement
    console.log('[RERANK] All results (rank changes):', JSON.stringify(rerankedResults.map(r => ({
      newRank: r.id,
      originalRank: r.originalRank,
      vectorScore: r.score,
      rerankScore: r.rerankScore,
      source: r.source,
      preview: r.content.substring(0, 150),
    })), null, 2));

    return rerankedResults;
  } catch (error) {
    console.error('[RERANK] Error:', {
      errorName: error.name,
      errorMessage: error.message,
      errorCode: error.$metadata?.httpStatusCode,
    });
    // Fall back to original results (top 10) if re-ranking fails
    console.log('[RERANK] Falling back to original retrieval results');
    return retrievedResults.slice(0, 5).map((r, i) => ({ ...r, originalRank: r.id, rerankScore: null }));
  }
}

// Step 2: Generate answer using retrieved context
async function generateAnswer(question, retrievedResults) {
  // Build context from retrieved results, including relevance scores
  const context = retrievedResults
    .map((r, i) => `[Source ${i + 1}] (relevance: ${r.rerankScore ? r.rerankScore.toFixed(4) : 'N/A'}): ${r.content}`)
    .join('\n\n');

  // Log the context being sent to the model
  console.log('[GENERATE] Context sources:', JSON.stringify(retrievedResults.map((r, i) => ({
    sourceNum: i + 1,
    source: r.source,
    rerankScore: r.rerankScore,
    vectorScore: r.score,
    charLength: r.content.length,
    preview: r.content.substring(0, 150),
  })), null, 2));
  console.log('[GENERATE] Total context length:', context.length, 'chars');

  const prompt = `You are AskUSDA, a helpful assistant for the United States Department of Agriculture.
Answer the user's question based ONLY on the provided context from USDA sources. If the context doesn't contain enough information to fully answer the question, provide what information you can from the context and note what aspects you couldn't find information about.
Be concise, accurate, and helpful. Format your response using markdown when appropriate. When citing information, reference the source number.

Context:
${context}

User Question: ${question}

Answer:`;

  // Use Amazon Nova Pro via inference profile
  const modelId = `us.amazon.nova-pro-v1:0`;

  const requestBody = {
    messages: [
      {
        role: 'user',
        content: [{ text: prompt }],
      },
    ],
    inferenceConfig: {
      maxTokens: 2048,
      temperature: 0.4,
      topP: 0.9,
    },
  };

  try {
    const generateStart = Date.now();
    const response = await bedrockRuntimeClient.send(new InvokeModelCommand({
      modelId: modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(requestBody),
    }));
    const generateMs = Date.now() - generateStart;

    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const answer = responseBody.output?.message?.content?.[0]?.text ||
                   responseBody.content?.[0]?.text ||
                   "I couldn't generate a response. Please try again.";

    console.log('[GENERATE] Completed:', {
      durationMs: generateMs,
      modelId,
      stopReason: responseBody.stopReason,
      usage: responseBody.usage,
      answerLength: answer.length,
    });

    return { answer, usage: responseBody.usage, stopReason: responseBody.stopReason };
  } catch (error) {
    console.error('[GENERATE] Error:', {
      errorName: error.name,
      errorMessage: error.message,
    });
    throw error;
  }
}

// Combined: Query Knowledge Base with three-step approach (retrieve + rerank + generate)
async function queryKnowledgeBase(question, sessionId) {
  const startTime = Date.now();
  console.log('[PIPELINE] Starting RAG pipeline for question:', question);

  // Step 1: Retrieve with confidence scores (30 results)
  const retrievedResults = await retrieveFromKnowledgeBase(question);
  const retrieveMs = Date.now() - startTime;

  // Calculate max confidence from original vector search (for logging)
  const maxVectorConfidence = retrievedResults.length > 0
    ? Math.max(...retrievedResults.map(r => r.score))
    : 0;

  // Step 1.5: Re-rank results to get top 10
  const rerankStart = Date.now();
  const rerankedResults = await rerankResults(question, retrievedResults);
  const rerankTotalMs = Date.now() - rerankStart;

  // Step 2: Generate answer using re-ranked context
  const generateStart = Date.now();
  const generateResult = await generateAnswer(question, rerankedResults);
  const generateTotalMs = Date.now() - generateStart;
  const responseTimeMs = Date.now() - startTime;

  // Build citations from re-ranked results
  const citations = rerankedResults.map(r => ({
    id: r.id,
    text: r.content.substring(0, 200),
    source: r.source,
    score: r.score,
    rerankScore: r.rerankScore,
  }));

  // Pipeline summary
  console.log('[PIPELINE] Complete:', {
    question,
    totalMs: responseTimeMs,
    retrieveMs,
    rerankMs: rerankTotalMs,
    generateMs: generateTotalMs,
    retrievedCount: retrievedResults.length,
    rerankedCount: rerankedResults.length,
    maxVectorConfidence,
    topRerankScore: rerankedResults[0]?.rerankScore,
    stopReason: generateResult.stopReason,
    tokenUsage: generateResult.usage,
    answerLength: generateResult.answer.length,
  });

  return {
    answer: generateResult.answer,
    citations,
    maxConfidence: maxVectorConfidence,
    sessionId: sessionId || uuidv4(),
    responseTimeMs,
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
