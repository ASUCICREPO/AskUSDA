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
import * as s3 from 'aws-cdk-lib/aws-s3';

export class USDAChatbotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ==================== Web Crawler Config (from CDK context) ====================
    const crawlerBucketName = this.node.tryGetContext('crawlerBucketName') || 'webcrawlerstack-crawlerdatabucketea3cc496-zrasanqbdtrx';
    const crawlerClusterArn = this.node.tryGetContext('crawlerClusterArn') || 'arn:aws:ecs:us-west-2:904233123149:cluster/web-crawler-cluster';
    const crawlerTaskDefArn = this.node.tryGetContext('crawlerTaskDefArn') || 'arn:aws:ecs:us-west-2:904233123149:task-definition/WebCrawlerStackCrawlerTaskDef07955191:1';
    const crawlerContainerName = this.node.tryGetContext('crawlerContainerName') || 'CrawlerContainer';
    const crawlerSubnetIds = this.node.tryGetContext('crawlerSubnetIds') || 'subnet-0371351a29fb1aaae,subnet-071a87c9587b5c6fa';
    const crawlerSecurityGroupId = this.node.tryGetContext('crawlerSecurityGroupId') || 'sg-02e3bb3712f4abfdb';

    // ==================== Amplify App ID (from CDK context) ====================
    const amplifyAppId = this.node.tryGetContext('amplifyAppId') || '';
    const frontendOrigin = amplifyAppId
      ? `https://master.${amplifyAppId}.amplifyapp.com`
      : '*';

    // ==================== DynamoDB - Conversation History ====================
    const conversationHistoryTable = new dynamodb.Table(this, 'ConversationHistory', {
      tableName: 'AskUSDA-ConversationHistory',
      partitionKey: { name: 'conversationId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    conversationHistoryTable.addGlobalSecondaryIndex({
      indexName: 'sessionId-timestamp-index',
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
    });

    conversationHistoryTable.addGlobalSecondaryIndex({
      indexName: 'date-timestamp-index',
      partitionKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
    });

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

    // ==================== IAM Role for Bedrock Knowledge Base ====================
    const knowledgeBaseRole = new iam.Role(this, 'KnowledgeBaseRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: 'IAM role for AskUSDA Knowledge Base',
    });

    knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    }));

    knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:ListFoundationModels', 'bedrock:GetFoundationModel'],
      resources: ['*'],
    }));

    knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:Rerank'],
      resources: ['*'],
    }));

    knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/amazon.rerank-v1:0`],
    }));

    knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3vectors:CreateIndex',
        's3vectors:GetIndex',
        's3vectors:PutVectors',
        's3vectors:GetVectors',
        's3vectors:DeleteVectors',
        's3vectors:QueryVectors',
        's3vectors:ListVectors',
      ],
      resources: ['*'],
    }));

    // ==================== S3 Bucket Reference (Web Crawler Output) ====================
    const crawlerBucket = s3.Bucket.fromBucketName(this, 'CrawlerDataBucket', crawlerBucketName);

    knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [
        crawlerBucket.bucketArn,
        `${crawlerBucket.bucketArn}/*`,
      ],
    }));

    // ==================== S3 Vectors — Vector Bucket ====================
    const s3VectorBucket = new cdk.CfnResource(this, 'S3VectorBucket', {
      type: 'AWS::S3Vectors::VectorBucket',
      properties: {
        VectorBucketName: 'askusda-vectors',
      },
    });

    // ==================== S3 Vectors — Vector Index ====================
    const s3VectorIndex = new cdk.CfnResource(this, 'S3VectorIndex', {
      type: 'AWS::S3Vectors::Index',
      properties: {
        VectorBucketName: 'askusda-vectors',
        IndexName: 'askusda-kb-index',
        DataType: 'float32',
        Dimension: 1024,
        DistanceMetric: 'cosine',
        MetadataConfiguration: {
          NonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT'],
        },
      },
    });
    s3VectorIndex.addDependency(s3VectorBucket);

    // ==================== S3 Vectors — Knowledge Base ====================
    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'USDAKnowledgeBaseS3V', {
      name: 'AskUSDA-KB',
      description: 'Knowledge base for USDA information using S3 Vectors store',
      roleArn: knowledgeBaseRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/amazon.titan-embed-text-v2:0`,
          embeddingModelConfiguration: {
            bedrockEmbeddingModelConfiguration: {
              dimensions: 1024,
              embeddingDataType: 'FLOAT32',
            },
          },
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: {
          vectorBucketArn: s3VectorBucket.getAtt('VectorBucketArn').toString(),
          indexName: 'askusda-kb-index',
        },
      },
    });
    knowledgeBase.addDependency(s3VectorIndex);

    const defaultPolicyConstruct = knowledgeBaseRole.node.tryFindChild('DefaultPolicy');
    if (defaultPolicyConstruct) {
      const cfnPolicy = defaultPolicyConstruct.node.defaultChild as cdk.CfnResource;
      if (cfnPolicy) {
        knowledgeBase.addDependency(cfnPolicy);
      }
    }

    // ==================== S3 Vectors — Data Source (ingestion-v3/) ====================
    const dataSource = new bedrock.CfnDataSource(this, 'CrawlerS3DataSourceS3V', {
      name: 'crawler-s3-v3',
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: crawlerBucket.bucketArn,
          inclusionPrefixes: ['ingestion-v3/'],
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'FIXED_SIZE',
          fixedSizeChunkingConfiguration: {
            maxTokens: 200,
            overlapPercentage: 15,
          },
        },
      },
    });
    dataSource.addDependency(knowledgeBase);

    // ==================== KB Sync Lambda (triggers crawl + ingestion) ====================
    const kbSyncLambdaRole = new iam.Role(this, 'KBSyncLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    kbSyncLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:StartIngestionJob'],
      resources: [`arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:knowledge-base/*`],
    }));

    kbSyncLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
      resources: [
        crawlerBucket.bucketArn,
        `${crawlerBucket.bucketArn}/*`,
      ],
    }));

    kbSyncLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ecs:RunTask'],
      resources: ['*'],
    }));

    kbSyncLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: ['*'],
      conditions: {
        StringLike: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
      },
    }));

    const kbSyncHandler = new lambda.Function(this, 'KBSyncHandler', {
      functionName: 'AskUSDA-KBSyncHandler',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/kb-sync-handler'),
      role: kbSyncLambdaRole,
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: {
        KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
        DATA_SOURCE_ID_V3: dataSource.attrDataSourceId,
        CRAWLER_BUCKET: crawlerBucketName,
        CRAWLER_CLUSTER_ARN: crawlerClusterArn,
        CRAWLER_TASK_DEF_ARN: crawlerTaskDefArn,
        CRAWLER_CONTAINER_NAME: crawlerContainerName,
        CRAWLER_SUBNETS: crawlerSubnetIds,
        CRAWLER_SG_ID: crawlerSecurityGroupId,
        CRAWLER_REGION: 'us-west-2',
      },
    });

    // ==================== IAM Role for WebSocket Lambda ====================
    const lambdaRole = new iam.Role(this, 'WebSocketLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    conversationHistoryTable.grantReadWriteData(lambdaRole);
    escalationTable.grantReadWriteData(lambdaRole);

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [
        crawlerBucket.bucketArn,
        `${crawlerBucket.bucketArn}/*`,
      ],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/amazon.nova-pro-v1:0',
        'arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0',
      ],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:GetInferenceProfile'],
      resources: [`arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/*`],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:Retrieve'],
      resources: [`arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:knowledge-base/*`],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:Rerank'],
      resources: ['*'],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/amazon.rerank-v1:0`],
    }));

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
      code: lambda.Code.fromAsset('lambda/websocket-handler'),
      role: lambdaRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        CONVERSATION_TABLE: conversationHistoryTable.tableName,
        ESCALATION_TABLE: escalationTable.tableName,
        BEDROCK_MODEL_ID: 'amazon.nova-pro-v1:0',
        KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
        AWS_ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
        CRAWLER_BUCKET: crawlerBucketName,
        CRAWLER_REGION: 'us-west-2',
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
      throttle: { rateLimit: 10, burstLimit: 20 },
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
    });

    webSocketHandler.addEnvironment('GUARDRAIL_ID', guardrail.attrGuardrailId);
    webSocketHandler.addEnvironment('GUARDRAIL_VERSION', guardrail.attrVersion);

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:ApplyGuardrail'],
      resources: [`arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:guardrail/${guardrail.attrGuardrailId}`],
    }));

    // ==================== Cognito User Pool for Admin Authentication ====================
    const adminUserPool = new cognito.UserPool(this, 'AdminUserPool', {
      userPoolName: 'AskUSDA-AdminPool',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 8, requireLowercase: true, requireUppercase: true,
        requireDigits: true, requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const adminAppClient = adminUserPool.addClient('AdminAppClient', {
      authFlows: { userPassword: true, userSrp: true },
      generateSecret: false,
      preventUserExistenceErrors: true,
    });

    // ==================== Admin API Lambda ====================
    const adminLambdaRole = new iam.Role(this, 'AdminLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    conversationHistoryTable.grantReadWriteData(adminLambdaRole);
    escalationTable.grantReadWriteData(adminLambdaRole);

    const adminHandler = new lambda.Function(this, 'AdminHandler', {
      functionName: 'AskUSDA-AdminHandler',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/admin-api'),
      role: adminLambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        CONVERSATION_TABLE: conversationHistoryTable.tableName,
        ESCALATION_TABLE: escalationTable.tableName,
        DATE_INDEX: 'date-timestamp-index',
        FEEDBACK_INDEX: 'feedback-timestamp-index',
        ALLOWED_ORIGIN: frontendOrigin,
      },
    });

    // ==================== Admin HTTP API Gateway ====================
    const allowedOrigins = frontendOrigin !== '*' ? [frontendOrigin] : ['*'];

    const adminApi = new apigatewayv2.HttpApi(this, 'AdminApi', {
      apiName: 'AskUSDA-AdminAPI',
      description: 'HTTP API for AskUSDA Admin Dashboard',
      corsPreflight: {
        allowHeaders: ['Content-Type', 'Authorization'],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET, apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.DELETE, apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: allowedOrigins,
        maxAge: cdk.Duration.days(1),
      },
    });

    const jwtAuthorizer = new apigatewayv2_authorizers.HttpJwtAuthorizer(
      'AdminJwtAuthorizer',
      `https://cognito-idp.${cdk.Aws.REGION}.amazonaws.com/${adminUserPool.userPoolId}`,
      { jwtAudience: [adminAppClient.userPoolClientId] }
    );

    const adminIntegration = new apigatewayv2_integrations.HttpLambdaIntegration('AdminIntegration', adminHandler);

    for (const path of ['/metrics', '/feedback', '/escalations']) {
      adminApi.addRoutes({ path, methods: [apigatewayv2.HttpMethod.GET], integration: adminIntegration, authorizer: jwtAuthorizer });
    }
    adminApi.addRoutes({ path: '/escalations/{id}', methods: [apigatewayv2.HttpMethod.DELETE], integration: adminIntegration, authorizer: jwtAuthorizer });
    adminApi.addRoutes({ path: '/feedback/{id}', methods: [apigatewayv2.HttpMethod.DELETE], integration: adminIntegration, authorizer: jwtAuthorizer });

    adminApi.addRoutes({ path: '/feedback', methods: [apigatewayv2.HttpMethod.POST], integration: adminIntegration });
    adminApi.addRoutes({ path: '/escalations', methods: [apigatewayv2.HttpMethod.POST], integration: adminIntegration });

    // ==================== Stack Outputs ====================
    new cdk.CfnOutput(this, 'WebSocketUrl', { value: webSocketStage.url, description: 'WebSocket API URL', exportName: 'AskUSDA-WebSocketUrl' });
    new cdk.CfnOutput(this, 'ConversationTableName', { value: conversationHistoryTable.tableName, description: 'DynamoDB Conversation History Table', exportName: 'AskUSDA-ConversationTable' });
    new cdk.CfnOutput(this, 'KnowledgeBaseId', { value: knowledgeBase.attrKnowledgeBaseId, description: 'Bedrock Knowledge Base ID (S3 Vectors)', exportName: 'AskUSDA-KnowledgeBaseId' });
    new cdk.CfnOutput(this, 'S3VectorBucketArn', { value: s3VectorBucket.getAtt('VectorBucketArn').toString(), description: 'S3 Vector Bucket ARN', exportName: 'AskUSDA-S3VectorBucketArn' });
    new cdk.CfnOutput(this, 'S3DataSourceV3Id', { value: dataSource.attrDataSourceId, description: 'S3 Data Source ID', exportName: 'AskUSDA-S3DataSourceV3Id' });
    new cdk.CfnOutput(this, 'CrawlerBucketName', { value: crawlerBucketName, description: 'Web Crawler S3 Bucket', exportName: 'AskUSDA-CrawlerBucket' });
    new cdk.CfnOutput(this, 'GuardrailId', { value: guardrail.attrGuardrailId, description: 'Bedrock Guardrail ID', exportName: 'AskUSDA-GuardrailId' });
    new cdk.CfnOutput(this, 'AdminApiUrl', { value: adminApi.apiEndpoint, description: 'Admin API URL', exportName: 'AskUSDA-AdminApiUrl' });
    new cdk.CfnOutput(this, 'EscalationTableName', { value: escalationTable.tableName, description: 'DynamoDB Escalation Requests Table', exportName: 'AskUSDA-EscalationTable' });
    new cdk.CfnOutput(this, 'AdminUserPoolId', { value: adminUserPool.userPoolId, description: 'Cognito User Pool ID', exportName: 'AskUSDA-AdminUserPoolId' });
    new cdk.CfnOutput(this, 'AdminUserPoolClientId', { value: adminAppClient.userPoolClientId, description: 'Cognito App Client ID', exportName: 'AskUSDA-AdminUserPoolClientId' });
  }
}
