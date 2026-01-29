import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2_integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigatewayv2_authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { opensearchserverless, opensearch_vectorindex } from '@cdklabs/generative-ai-cdk-constructs';

export class USDAChatbotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ==================== DynamoDB - Conversation History ====================
    // Table to store conversation history for analytics and admin dashboard
    const conversationHistoryTable = new dynamodb.Table(this, 'ConversationHistory', {
      tableName: 'AskUSDA-ConversationHistory',
      partitionKey: { name: 'conversationId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // GSI for querying by sessionId
    conversationHistoryTable.addGlobalSecondaryIndex({
      indexName: 'sessionId-timestamp-index',
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
    });

    // GSI for querying by date (for admin dashboard analytics)
    conversationHistoryTable.addGlobalSecondaryIndex({
      indexName: 'date-timestamp-index',
      partitionKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
    });

    // GSI for querying by feedback status
    conversationHistoryTable.addGlobalSecondaryIndex({
      indexName: 'feedback-timestamp-index',
      partitionKey: { name: 'feedback', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
    });

    // ==================== DynamoDB - Escalation Requests ====================
    const escalationTable = new dynamodb.Table(this, 'EscalationRequests', {
      tableName: 'AskUSDA-EscalationRequests',
      partitionKey: { name: 'escalationId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    escalationTable.addGlobalSecondaryIndex({
      indexName: 'DateTimestampIndex',
      partitionKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
    });

    // ==================== OpenSearch Serverless Vector Collection (L2 Construct) ====================
    // Using @cdklabs/generative-ai-cdk-constructs which automatically handles:
    // - Encryption policy
    // - Network policy  
    // - Data access policy
    const vectorCollection = new opensearchserverless.VectorCollection(this, 'VectorCollection', {
      collectionName: 'askusda-vectors',
      description: 'Vector store for AskUSDA Knowledge Base',
      standbyReplicas: opensearchserverless.VectorCollectionStandbyReplicas.DISABLED, // Cost optimization
    });

    // ==================== OpenSearch Vector Index (L2 Construct) ====================
    // This automatically creates the index with proper mappings for Bedrock Knowledge Base
    const vectorIndex = new opensearch_vectorindex.VectorIndex(this, 'VectorIndex', {
      collection: vectorCollection,
      indexName: 'askusda-index',
      vectorDimensions: 1024, // Amazon Titan Embed Text v2 dimension
      vectorField: 'vector',
      precision: 'float',
      distanceType: 'l2',
      mappings: [
        {
          mappingField: 'text',
          dataType: 'text',
          filterable: true,
        },
        {
          mappingField: 'metadata',
          dataType: 'text',
          filterable: false,
        },
        {
          mappingField: 'AMAZON_BEDROCK_TEXT_CHUNK',
          dataType: 'text',
          filterable: true,
        },
        {
          mappingField: 'AMAZON_BEDROCK_METADATA',
          dataType: 'text',
          filterable: false,
        },
      ],
    });

    // ==================== IAM Role for Bedrock Knowledge Base ====================
    const knowledgeBaseRole = new iam.Role(this, 'KnowledgeBaseRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: 'IAM role for AskUSDA Knowledge Base',
    });

    // Grant full Bedrock access for Knowledge Base operations
    knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:*'],
      resources: ['*'],
    }));

    // Grant data access to the OpenSearch Serverless collection
    vectorCollection.grantDataAccess(knowledgeBaseRole);

    // Add OpenSearch Serverless API permissions for Knowledge Base
    knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['aoss:APIAccessAll'],
      resources: [vectorCollection.collectionArn],
    }));

    // ==================== Bedrock Knowledge Base ====================
    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'USDAKnowledgeBase', {
      name: 'AskUSDA-KnowledgeBase',
      description: 'Knowledge base for USDA information using web crawler',
      roleArn: knowledgeBaseRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/amazon.titan-embed-text-v2:0`,
        },
      },
      storageConfiguration: {
        type: 'OPENSEARCH_SERVERLESS',
        opensearchServerlessConfiguration: {
          collectionArn: vectorCollection.collectionArn,
          vectorIndexName: vectorIndex.indexName,
          fieldMapping: {
            vectorField: vectorIndex.vectorField,
            textField: 'AMAZON_BEDROCK_TEXT_CHUNK',
            metadataField: 'AMAZON_BEDROCK_METADATA',
          },
        },
      },
    });

    // Ensure knowledge base is created after vector index
    knowledgeBase.node.addDependency(vectorIndex);

    // Add explicit dependency on the IAM role's default policy
    const defaultPolicyConstruct = knowledgeBaseRole.node.tryFindChild('DefaultPolicy');
    if (defaultPolicyConstruct) {
      const cfnPolicy = defaultPolicyConstruct.node.defaultChild as cdk.CfnResource;
      if (cfnPolicy) {
        knowledgeBase.addDependency(cfnPolicy);
      }
    }

    // Web Crawler Data Source
    const webCrawlerDataSource = new bedrock.CfnDataSource(this, 'WebCrawlerDataSource', {
      name: 'AskUSDA-WebCrawler',
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      dataSourceConfiguration: {
        type: 'WEB',
        webConfiguration: {
          sourceConfiguration: {
            urlConfiguration: {
              seedUrls: [
                { url: 'https://www.usda.gov/'},
                { url: 'https://www.farmers.gov/'},
              ],
            },
          },
          crawlerConfiguration: {
            crawlerLimits: {
              rateLimit: 50,
            },
            scope: 'HOST_ONLY',
          },
        },
      },
    });

    // Ensure data source is created after knowledge base
    webCrawlerDataSource.addDependency(knowledgeBase);

    // ==================== Daily Knowledge Base Sync (EventBridge + Lambda) ====================
    // Lambda function to trigger KB sync
    const kbSyncLambdaRole = new iam.Role(this, 'KBSyncLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Grant permission to start ingestion job
    kbSyncLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:StartIngestionJob'],
      resources: [`arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:knowledge-base/*`],
    }));

    const kbSyncHandler = new lambda.Function(this, 'KBSyncHandler', {
      functionName: 'AskUSDA-KBSyncHandler',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { BedrockAgentClient, StartIngestionJobCommand } = require('@aws-sdk/client-bedrock-agent');

const client = new BedrockAgentClient({});

exports.handler = async (event) => {
  console.log('Starting Knowledge Base sync job...');
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID;
  const dataSourceId = process.env.DATA_SOURCE_ID;
  
  try {
    const response = await client.send(new StartIngestionJobCommand({
      knowledgeBaseId,
      dataSourceId,
    }));
    
    console.log('Ingestion job started successfully:', JSON.stringify(response, null, 2));
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Knowledge Base sync started',
        ingestionJobId: response.ingestionJob?.ingestionJobId,
      }),
    };
  } catch (error) {
    console.error('Error starting ingestion job:', error);
    throw error;
  }
};
      `),
      role: kbSyncLambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      environment: {
        KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
        DATA_SOURCE_ID: webCrawlerDataSource.attrDataSourceId,
      },
    });

    // EventBridge rule to trigger daily at 6:00 AM UTC (off-peak hours)
    // This is ~11 PM PST / 2 AM EST - good for US government sites
    const dailySyncRule = new events.Rule(this, 'DailyKBSyncRule', {
      ruleName: 'AskUSDA-DailyKBSync',
      description: 'Triggers daily Knowledge Base sync at 6:00 AM UTC',
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '6',
        day: '*',
        month: '*',
        year: '*',
      }),
    });

    dailySyncRule.addTarget(new targets.LambdaFunction(kbSyncHandler, {
      retryAttempts: 2,
    }));

    // ==================== IAM Role for Lambda ====================
    const lambdaRole = new iam.Role(this, 'WebSocketLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    conversationHistoryTable.grantReadWriteData(lambdaRole);
    escalationTable.grantReadWriteData(lambdaRole);

    // Bedrock permissions - Nova Pro & Titan Embeddings
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/amazon.nova-pro-v1:0`,
        `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    }));

    // Bedrock Knowledge Base permissions
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
      resources: [`arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:knowledge-base/*`],
    }));

    // OpenSearch Serverless permissions
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['aoss:APIAccessAll'],
      resources: [vectorCollection.collectionArn],
    }));

    // API Gateway Management permissions
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['execute-api:ManageConnections'],
      resources: [`arn:aws:execute-api:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*/*`],
    }));


    // ==================== WebSocket Lambda ====================
    const webSocketHandler = new lambda.Function(this, 'WebSocketHandler', {
      functionName: 'AskUSDA-WebSocketHandler',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/websocket-handler', {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash', '-c',
            'npm install && cp -au . /asset-output'
          ],
        },
      }),
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        CONVERSATION_TABLE: conversationHistoryTable.tableName,
        ESCALATION_TABLE: escalationTable.tableName,
        OPENSEARCH_ENDPOINT: vectorCollection.collectionEndpoint,
        BEDROCK_MODEL_ID: 'amazon.nova-pro-v1:0',
        EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
        KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
      },
    });

    // ==================== WebSocket API Gateway ====================
    const webSocketApi = new apigatewayv2.WebSocketApi(this, 'WebSocketApi', {
      apiName: 'AskUSDA-WebSocket',
      description: 'WebSocket API for AskUSDA Chatbot',
      connectRouteOptions: {
        integration: new apigatewayv2_integrations.WebSocketLambdaIntegration('ConnectIntegration', webSocketHandler),
      },
      disconnectRouteOptions: {
        integration: new apigatewayv2_integrations.WebSocketLambdaIntegration('DisconnectIntegration', webSocketHandler),
      },
      defaultRouteOptions: {
        integration: new apigatewayv2_integrations.WebSocketLambdaIntegration('DefaultIntegration', webSocketHandler),
      },
    });

    webSocketApi.addRoute('sendMessage', {
      integration: new apigatewayv2_integrations.WebSocketLambdaIntegration('SendMessageIntegration', webSocketHandler),
    });

    webSocketApi.addRoute('submitFeedback', {
      integration: new apigatewayv2_integrations.WebSocketLambdaIntegration('SubmitFeedbackIntegration', webSocketHandler),
    });

    webSocketApi.addRoute('submitEscalation', {
      integration: new apigatewayv2_integrations.WebSocketLambdaIntegration('SubmitEscalationIntegration', webSocketHandler),
    });

    const webSocketStage = new apigatewayv2.WebSocketStage(this, 'WebSocketStage', {
      webSocketApi,
      stageName: 'prod',
      autoDeploy: true,
    });

    webSocketHandler.addEnvironment('WEBSOCKET_ENDPOINT', webSocketStage.callbackUrl);

    // ==================== Bedrock Guardrail ====================
    const guardrail = new bedrock.CfnGuardrail(this, 'USDAGuardrail', {
      name: 'AskUSDA-Guardrail',
      description: 'Content filtering guardrail for AskUSDA chatbot',
      blockedInputMessaging: 'I cannot process this request as it contains inappropriate content.',
      blockedOutputsMessaging: 'I cannot provide this response as it may contain inappropriate content.',
      contentPolicyConfig: {
        filtersConfig: [
          { type: 'SEXUAL', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'VIOLENCE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'HATE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'INSULTS', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'MISCONDUCT', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
        ],
      },
      // Removed topicPolicyConfig - was too restrictive for legitimate USDA questions
    });

    // Add guardrail to Lambda environment
    webSocketHandler.addEnvironment('GUARDRAIL_ID', guardrail.attrGuardrailId);
    webSocketHandler.addEnvironment('GUARDRAIL_VERSION', guardrail.attrVersion);

    // Add guardrail permissions to Lambda
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:ApplyGuardrail'],
      resources: [`arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:guardrail/${guardrail.attrGuardrailId}`],
    }));

    // ==================== Cognito User Pool for Admin Authentication ====================
    const adminUserPool = new cognito.UserPool(this, 'AdminUserPool', {
      userPoolName: 'AskUSDA-AdminPool',
      selfSignUpEnabled: false, // Only admins can create users
      signInAliases: {
        email: true, // Use email as the sign-in identifier
      },
      autoVerify: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // App client for the admin dashboard
    const adminAppClient = adminUserPool.addClient('AdminAppClient', {
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false, // For browser-based apps
      preventUserExistenceErrors: true,
    });

    // ==================== Admin API Lambda ====================
    const adminLambdaRole = new iam.Role(this, 'AdminLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Grant DynamoDB access to admin Lambda
    conversationHistoryTable.grantReadWriteData(adminLambdaRole);
    escalationTable.grantReadWriteData(adminLambdaRole);

    const adminHandler = new lambda.Function(this, 'AdminHandler', {
      functionName: 'AskUSDA-AdminHandler',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/admin-api', {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash', '-c',
            'npm install && cp -au . /asset-output'
          ],
        },
      }),
      role: adminLambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        CONVERSATION_TABLE: conversationHistoryTable.tableName,
        ESCALATION_TABLE: escalationTable.tableName,
        DATE_INDEX: 'date-timestamp-index',
        FEEDBACK_INDEX: 'feedback-timestamp-index',
      },
    });

    // ==================== Admin HTTP API Gateway ====================
    const adminApi = new apigatewayv2.HttpApi(this, 'AdminApi', {
      apiName: 'AskUSDA-AdminAPI',
      description: 'HTTP API for AskUSDA Admin Dashboard',
      corsPreflight: {
        allowHeaders: ['Content-Type', 'Authorization'],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.DELETE,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ['*'],
        maxAge: cdk.Duration.days(1),
      },
    });

    // JWT Authorizer for Cognito
    const jwtAuthorizer = new apigatewayv2_authorizers.HttpJwtAuthorizer(
      'AdminJwtAuthorizer',
      `https://cognito-idp.${cdk.Aws.REGION}.amazonaws.com/${adminUserPool.userPoolId}`,
      {
        jwtAudience: [adminAppClient.userPoolClientId],
      }
    );

    // Add routes
    const adminIntegration = new apigatewayv2_integrations.HttpLambdaIntegration(
      'AdminIntegration',
      adminHandler
    );

    // Protected routes (require Cognito auth)
    adminApi.addRoutes({
      path: '/metrics',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: adminIntegration,
      authorizer: jwtAuthorizer,
    });

    adminApi.addRoutes({
      path: '/feedback',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: adminIntegration,
      authorizer: jwtAuthorizer,
    });

    adminApi.addRoutes({
      path: '/escalations',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: adminIntegration,
      authorizer: jwtAuthorizer,
    });

    adminApi.addRoutes({
      path: '/escalations/{id}',
      methods: [apigatewayv2.HttpMethod.DELETE],
      integration: adminIntegration,
      authorizer: jwtAuthorizer,
    });

    // Public routes (no auth required - for submitting feedback/escalations from chatbot)
    adminApi.addRoutes({
      path: '/feedback',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: adminIntegration,
    });

    adminApi.addRoutes({
      path: '/escalations',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: adminIntegration,
    });

    // ==================== Stack Outputs ====================
    new cdk.CfnOutput(this, 'WebSocketUrl', {
      value: webSocketStage.url,
      description: 'WebSocket API URL',
      exportName: 'AskUSDA-WebSocketUrl',
    });

    new cdk.CfnOutput(this, 'ConversationTableName', {
      value: conversationHistoryTable.tableName,
      description: 'DynamoDB Conversation History Table',
      exportName: 'AskUSDA-ConversationTable',
    });

    new cdk.CfnOutput(this, 'KnowledgeBaseId', {
      value: knowledgeBase.attrKnowledgeBaseId,
      description: 'Bedrock Knowledge Base ID',
      exportName: 'AskUSDA-KnowledgeBaseId',
    });

    new cdk.CfnOutput(this, 'OpenSearchCollectionEndpoint', {
      value: vectorCollection.collectionEndpoint,
      description: 'OpenSearch Serverless Collection Endpoint',
      exportName: 'AskUSDA-OpenSearchEndpoint',
    });

    new cdk.CfnOutput(this, 'WebCrawlerDataSourceId', {
      value: webCrawlerDataSource.attrDataSourceId,
      description: 'Web Crawler Data Source ID',
      exportName: 'AskUSDA-WebCrawlerDataSourceId',
    });

    new cdk.CfnOutput(this, 'GuardrailId', {
      value: guardrail.attrGuardrailId,
      description: 'Bedrock Guardrail ID',
      exportName: 'AskUSDA-GuardrailId',
    });

    new cdk.CfnOutput(this, 'AdminApiUrl', {
      value: adminApi.apiEndpoint,
      description: 'Admin API URL',
      exportName: 'AskUSDA-AdminApiUrl',
    });

    new cdk.CfnOutput(this, 'EscalationTableName', {
      value: escalationTable.tableName,
      description: 'DynamoDB Escalation Requests Table',
      exportName: 'AskUSDA-EscalationTable',
    });

    // Cognito Outputs
    new cdk.CfnOutput(this, 'AdminUserPoolId', {
      value: adminUserPool.userPoolId,
      description: 'Cognito User Pool ID for admin authentication',
      exportName: 'AskUSDA-AdminUserPoolId',
    });

    new cdk.CfnOutput(this, 'AdminUserPoolClientId', {
      value: adminAppClient.userPoolClientId,
      description: 'Cognito App Client ID for admin dashboard',
      exportName: 'AskUSDA-AdminUserPoolClientId',
    });
  }
}
