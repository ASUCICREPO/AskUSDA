import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2_integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { opensearchserverless, opensearch_vectorindex } from '@cdklabs/generative-ai-cdk-constructs';

export class USDAChatbotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ==================== DynamoDB - Conversation Logs ====================
    const conversationLogsTable = new dynamodb.Table(this, 'ConversationLogs', {
      tableName: 'AskUSDA-ConversationLogs',
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    conversationLogsTable.addGlobalSecondaryIndex({
      indexName: 'SessionIndex',
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
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
                { url: 'https://www.usda.gov/' },
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

    // ==================== IAM Role for Lambda ====================
    const lambdaRole = new iam.Role(this, 'WebSocketLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    conversationLogsTable.grantReadWriteData(lambdaRole);

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
      code: lambda.Code.fromAsset('lambda-bundle'),
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        CONVERSATION_TABLE: conversationLogsTable.tableName,
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
          { type: 'INSULTS', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'MISCONDUCT', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
        ],
      },
      topicPolicyConfig: {
        topicsConfig: [
          {
            name: 'OffTopic',
            definition: 'Questions not related to USDA, agriculture, food safety, nutrition, or rural development',
            examples: ['What is the weather today?', 'Tell me a joke', 'Who won the election?'],
            type: 'DENY',
          },
        ],
      },
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

    // ==================== Amplify Hosting ====================
    // Note: You need to create a GitHub token secret in Secrets Manager first
    // aws secretsmanager create-secret --name github-token --secret-string "your-github-token"
    const githubToken = secretsmanager.Secret.fromSecretNameV2(this, 'GitHubToken', 'usda-token');

    const amplifyApp = new amplify.CfnApp(this, 'AmplifyApp', {
      name: 'AskUSDA-Frontend',
      description: 'AskUSDA Chatbot Frontend',
      repository: 'https://github.com/ASUCICREPO/AskUSDA', // Update with your repo
      accessToken: githubToken.secretValue.unsafeUnwrap(),
      platform: 'WEB_COMPUTE',
      environmentVariables: [
        { name: 'NEXT_PUBLIC_WEBSOCKET_URL', value: webSocketStage.url },
      ],
      buildSpec: cdk.Fn.sub(`
version: 1
frontend:
  phases:
    preBuild:
      commands:
        - cd frontend
        - npm ci
    build:
      commands:
        - npm run build
  artifacts:
    baseDirectory: frontend/.next
    files:
      - '**/*'
  cache:
    paths:
      - frontend/node_modules/**/*
`),
    });

    // Master branch
    new amplify.CfnBranch(this, 'MasterBranch', {
      appId: amplifyApp.attrAppId,
      branchName: 'master',
      enableAutoBuild: true,
      stage: 'PRODUCTION',
      environmentVariables: [
        { name: 'NEXT_PUBLIC_WEBSOCKET_URL', value: webSocketStage.url },
      ],
    });

    // ==================== Stack Outputs ====================
    new cdk.CfnOutput(this, 'WebSocketUrl', {
      value: webSocketStage.url,
      description: 'WebSocket API URL',
      exportName: 'AskUSDA-WebSocketUrl',
    });

    new cdk.CfnOutput(this, 'ConversationTableName', {
      value: conversationLogsTable.tableName,
      description: 'DynamoDB Conversation Logs Table',
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

    new cdk.CfnOutput(this, 'AmplifyAppUrl', {
      value: `https://master.${amplifyApp.attrDefaultDomain}`,
      description: 'Amplify App URL',
      exportName: 'AskUSDA-AmplifyUrl',
    });
  }
}
