const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, ScanCommand, DeleteCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');

// Initialize clients
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

// Environment variables
const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE;
const ESCALATION_TABLE = process.env.ESCALATION_TABLE;
const DATE_INDEX = process.env.DATE_INDEX || 'date-timestamp-index';
const FEEDBACK_INDEX = process.env.FEEDBACK_INDEX || 'feedback-timestamp-index';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Content-Type': 'application/json',
};

// Helper to create response
function response(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body),
  };
}

// Get metrics for dashboard
async function getMetrics(days = 7) {
  const now = new Date();
  const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  
  // Get conversations by day
  const conversationsByDay = [];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = date.toISOString().split('T')[0];
    
    try {
      const result = await docClient.send(new QueryCommand({
        TableName: CONVERSATION_TABLE,
        IndexName: DATE_INDEX,
        KeyConditionExpression: '#date = :date',
        ExpressionAttributeNames: { '#date': 'date' },
        ExpressionAttributeValues: { ':date': dateStr },
        Select: 'COUNT',
      }));
      
      conversationsByDay.push({
        date: dateStr,
        count: result.Count || 0,
        dayName: dayNames[date.getDay()],
        label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      });
    } catch (error) {
      console.error(`Error querying date ${dateStr}:`, error);
      conversationsByDay.push({
        date: dateStr,
        count: 0,
        dayName: dayNames[date.getDay()],
        label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      });
    }
  }

  // Get total conversations
  let totalConversations = 0;
  let totalFeedback = 0;
  let positiveFeedback = 0;
  let negativeFeedback = 0;
  let totalResponseTime = 0;
  let responseTimeCount = 0;

  try {
    // Scan for totals (consider using a separate metrics table for production)
    let lastKey = undefined;
    do {
      const scanResult = await docClient.send(new ScanCommand({
        TableName: CONVERSATION_TABLE,
        ExclusiveStartKey: lastKey,
        ProjectionExpression: 'feedback, responseTimeMs',
      }));

      totalConversations += scanResult.Items?.length || 0;
      
      for (const item of scanResult.Items || []) {
        if (item.feedback) {
          totalFeedback++;
          if (item.feedback === 'pos') positiveFeedback++;
          if (item.feedback === 'neg') negativeFeedback++;
        }
        if (item.responseTimeMs) {
          totalResponseTime += item.responseTimeMs;
          responseTimeCount++;
        }
      }

      lastKey = scanResult.LastEvaluatedKey;
    } while (lastKey);
  } catch (error) {
    console.error('Error scanning conversations:', error);
  }

  // Get today's conversations
  const todayStr = now.toISOString().split('T')[0];
  const conversationsToday = conversationsByDay.find(d => d.date === todayStr)?.count || 0;

  return {
    totalConversations,
    conversationsToday,
    totalFeedback,
    positiveFeedback,
    negativeFeedback,
    noFeedback: totalConversations - totalFeedback,
    satisfactionRate: totalFeedback > 0 ? Math.round((positiveFeedback / totalFeedback) * 100) : 0,
    avgResponseTimeMs: responseTimeCount > 0 ? Math.round(totalResponseTime / responseTimeCount) : 0,
    conversationsByDay,
  };
}

// Get feedback conversations (only returns conversations with feedback - pos or neg)
async function getFeedbackConversations(limit = 50, offset = 0, feedbackFilter = null) {
  let allConversations = [];
  
  try {
    if (feedbackFilter && (feedbackFilter === 'pos' || feedbackFilter === 'neg')) {
      // Query by specific feedback type - get all items for counting
      let lastKey = undefined;
      do {
        const result = await docClient.send(new QueryCommand({
          TableName: CONVERSATION_TABLE,
          IndexName: FEEDBACK_INDEX,
          KeyConditionExpression: 'feedback = :feedback',
          ExpressionAttributeValues: { ':feedback': feedbackFilter },
          ScanIndexForward: false,
          ExclusiveStartKey: lastKey,
        }));
        allConversations.push(...(result.Items || []));
        lastKey = result.LastEvaluatedKey;
      } while (lastKey);
    } else {
      // Get both positive and negative feedback (exclude conversations with no feedback)
      const [posItems, negItems] = await Promise.all([
        (async () => {
          const items = [];
          let lastKey = undefined;
          do {
            const result = await docClient.send(new QueryCommand({
              TableName: CONVERSATION_TABLE,
              IndexName: FEEDBACK_INDEX,
              KeyConditionExpression: 'feedback = :feedback',
              ExpressionAttributeValues: { ':feedback': 'pos' },
              ScanIndexForward: false,
              ExclusiveStartKey: lastKey,
            }));
            items.push(...(result.Items || []));
            lastKey = result.LastEvaluatedKey;
          } while (lastKey);
          return items;
        })(),
        (async () => {
          const items = [];
          let lastKey = undefined;
          do {
            const result = await docClient.send(new QueryCommand({
              TableName: CONVERSATION_TABLE,
              IndexName: FEEDBACK_INDEX,
              KeyConditionExpression: 'feedback = :feedback',
              ExpressionAttributeValues: { ':feedback': 'neg' },
              ScanIndexForward: false,
              ExclusiveStartKey: lastKey,
            }));
            items.push(...(result.Items || []));
            lastKey = result.LastEvaluatedKey;
          } while (lastKey);
          return items;
        })(),
      ]);
      
      // Combine and sort by timestamp descending
      allConversations = [...posItems, ...negItems];
      allConversations.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }
  } catch (error) {
    console.error('Error getting feedback conversations:', error);
  }

  // Apply pagination
  const total = allConversations.length;
  const paginatedConversations = allConversations.slice(offset, offset + limit);

  return {
    total,
    conversations: paginatedConversations.map(conv => {
      // Parse citations from JSON string
      let citations = [];
      try {
        citations = conv.citations ? JSON.parse(conv.citations) : [];
      } catch (e) {
        citations = [];
      }
      
      // Calculate confidence score based on citation scores (industry standard approach)
      // Average the top citation scores, normalized to 0-100
      let confidenceScore = 0;
      if (citations.length > 0) {
        const avgScore = citations.reduce((sum, c) => sum + (c.score || 0), 0) / citations.length;
        confidenceScore = Math.round(avgScore * 100);
      }
      
      return {
        conversationId: conv.conversationId,
        sessionId: conv.sessionId,
        question: conv.question,
        answerPreview: conv.answerPreview || conv.answer?.substring(0, 500),
        feedback: conv.feedback || null,
        timestamp: conv.timestamp,
        date: conv.date,
        responseTimeMs: conv.responseTimeMs,
        citations: citations,
        confidenceScore: confidenceScore,
      };
    }),
  };
}

// Get escalation requests
async function getEscalations(limit = 50, offset = 0) {
  try {
    // Get all items for proper pagination
    let allItems = [];
    let lastKey = undefined;
    do {
      const result = await docClient.send(new ScanCommand({
        TableName: ESCALATION_TABLE,
        ExclusiveStartKey: lastKey,
      }));
      allItems.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    // Sort by timestamp descending
    allItems.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    const total = allItems.length;
    const paginatedItems = allItems.slice(offset, offset + limit);

    const escalations = paginatedItems.map(item => ({
      id: item.escalationId,
      name: item.name,
      email: item.email,
      phone: item.phone || '',
      question: item.question,
      requestDate: item.timestamp,
      status: item.status || 'pending',
    }));

    return { escalations, total };
  } catch (error) {
    console.error('Error getting escalations:', error);
    return { escalations: [], total: 0 };
  }
}

// Delete escalation
async function deleteEscalation(escalationId) {
  try {
    // First find the item to get the timestamp (sort key)
    const scanResult = await docClient.send(new ScanCommand({
      TableName: ESCALATION_TABLE,
      FilterExpression: 'escalationId = :id',
      ExpressionAttributeValues: { ':id': escalationId },
    }));

    if (!scanResult.Items || scanResult.Items.length === 0) {
      return { success: false, message: 'Escalation not found' };
    }

    const item = scanResult.Items[0];
    
    await docClient.send(new DeleteCommand({
      TableName: ESCALATION_TABLE,
      Key: {
        escalationId: item.escalationId,
        timestamp: item.timestamp,
      },
    }));

    return { success: true };
  } catch (error) {
    console.error('Error deleting escalation:', error);
    return { success: false, message: error.message };
  }
}

// Create escalation (public endpoint)
async function createEscalation(body) {
  const { name, email, phone, question, sessionId } = body;

  if (!name || !email || !question) {
    return response(400, { error: 'Name, email, and question are required' });
  }

  const escalationId = uuidv4();
  const now = new Date();
  const timestamp = now.toISOString();
  const date = timestamp.split('T')[0]; // For GSI
  const ttl = Math.floor(now.getTime() / 1000) + (365 * 24 * 60 * 60);

  try {
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

    return response(200, { success: true, escalationId });
  } catch (error) {
    console.error('Error creating escalation:', error);
    return response(500, { error: 'Failed to create escalation' });
  }
}

// Create feedback (public endpoint)
async function createFeedback(body) {
  const { conversationId, feedback } = body;

  if (!conversationId || !feedback) {
    return response(400, { error: 'conversationId and feedback are required' });
  }

  try {
    // Find the conversation
    const queryResult = await docClient.send(new QueryCommand({
      TableName: CONVERSATION_TABLE,
      KeyConditionExpression: 'conversationId = :cid',
      ExpressionAttributeValues: { ':cid': conversationId },
      Limit: 1,
    }));

    if (!queryResult.Items || queryResult.Items.length === 0) {
      return response(404, { error: 'Conversation not found' });
    }

    const item = queryResult.Items[0];
    
    const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    await docClient.send(new UpdateCommand({
      TableName: CONVERSATION_TABLE,
      Key: {
        conversationId: item.conversationId,
        timestamp: item.timestamp,
      },
      UpdateExpression: 'SET feedback = :feedback, feedbackTs = :feedbackTs',
      ExpressionAttributeValues: {
        ':feedback': feedback === 'positive' ? 'pos' : 'neg',
        ':feedbackTs': new Date().toISOString(),
      },
    }));

    return response(200, { success: true });
  } catch (error) {
    console.error('Error creating feedback:', error);
    return response(500, { error: 'Failed to save feedback' });
  }
}

// Main handler
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  // HTTP API v2 uses different event structure
  const httpMethod = event.requestContext?.http?.method || event.httpMethod;
  const path = event.rawPath || event.path;
  const pathParameters = event.pathParameters;
  const queryStringParameters = event.queryStringParameters;
  const body = event.body;

  // Handle CORS preflight
  if (httpMethod === 'OPTIONS') {
    return response(200, {});
  }

  try {
    // Route handling
    if (path === '/metrics' && httpMethod === 'GET') {
      const days = parseInt(queryStringParameters?.days || '7', 10);
      const metrics = await getMetrics(days);
      return response(200, metrics);
    }

    if (path === '/feedback' && httpMethod === 'GET') {
      const limit = parseInt(queryStringParameters?.limit || '50', 10);
      const offset = parseInt(queryStringParameters?.offset || '0', 10);
      const feedbackFilter = queryStringParameters?.filter;
      const result = await getFeedbackConversations(limit, offset, feedbackFilter);
      return response(200, result);
    }

    if (path === '/feedback' && httpMethod === 'POST') {
      return await createFeedback(JSON.parse(body || '{}'));
    }

    if (path === '/escalations' && httpMethod === 'GET') {
      const limit = parseInt(queryStringParameters?.limit || '50', 10);
      const offset = parseInt(queryStringParameters?.offset || '0', 10);
      const result = await getEscalations(limit, offset);
      return response(200, result);
    }

    if (path === '/escalations' && httpMethod === 'POST') {
      return await createEscalation(JSON.parse(body || '{}'));
    }

    if (path && path.startsWith('/escalations/') && httpMethod === 'DELETE') {
      const escalationId = pathParameters?.id || path.split('/').pop();
      const result = await deleteEscalation(escalationId);
      return response(result.success ? 200 : 404, result);
    }

    return response(404, { error: 'Not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return response(500, { error: 'Internal server error' });
  }
};
