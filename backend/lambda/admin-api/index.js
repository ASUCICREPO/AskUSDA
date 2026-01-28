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

// Get feedback conversations
async function getFeedbackConversations(limit = 50, feedbackFilter = null) {
  const conversations = [];
  
  try {
    if (feedbackFilter && (feedbackFilter === 'pos' || feedbackFilter === 'neg')) {
      // Query by feedback index
      const result = await docClient.send(new QueryCommand({
        TableName: CONVERSATION_TABLE,
        IndexName: FEEDBACK_INDEX,
        KeyConditionExpression: 'feedback = :feedback',
        ExpressionAttributeValues: { ':feedback': feedbackFilter },
        ScanIndexForward: false,
        Limit: limit,
      }));
      conversations.push(...(result.Items || []));
    } else {
      // Scan all conversations
      const result = await docClient.send(new ScanCommand({
        TableName: CONVERSATION_TABLE,
        Limit: limit,
      }));
      
      // Sort by timestamp descending
      const items = result.Items || [];
      items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      conversations.push(...items);
    }
  } catch (error) {
    console.error('Error getting feedback conversations:', error);
  }

  return {
    conversations: conversations.map(conv => ({
      conversationId: conv.conversationId,
      sessionId: conv.sessionId,
      question: conv.question,
      answerPreview: conv.answerPreview || conv.answer?.substring(0, 500),
      feedback: conv.feedback || null,
      timestamp: conv.timestamp,
      date: conv.date,
      responseTimeMs: conv.responseTimeMs,
    })),
  };
}

// Get escalation requests
async function getEscalations() {
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: ESCALATION_TABLE,
    }));

    const escalations = (result.Items || [])
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .map(item => ({
        id: item.escalationId,
        name: item.name,
        email: item.email,
        phone: item.phone || '',
        question: item.question,
        requestDate: item.timestamp,
        status: item.status || 'pending',
      }));

    return { escalations };
  } catch (error) {
    console.error('Error getting escalations:', error);
    return { escalations: [] };
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

  const { httpMethod, path, pathParameters, queryStringParameters, body } = event;

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
      const feedbackFilter = queryStringParameters?.filter;
      const result = await getFeedbackConversations(limit, feedbackFilter);
      return response(200, result);
    }

    if (path === '/feedback' && httpMethod === 'POST') {
      return await createFeedback(JSON.parse(body || '{}'));
    }

    if (path === '/escalations' && httpMethod === 'GET') {
      const result = await getEscalations();
      return response(200, result);
    }

    if (path === '/escalations' && httpMethod === 'POST') {
      return await createEscalation(JSON.parse(body || '{}'));
    }

    if (path.startsWith('/escalations/') && httpMethod === 'DELETE') {
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
