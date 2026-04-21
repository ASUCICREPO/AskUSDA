#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { USDAChatbotStack } from '../lib/backend-stack';
import { CrawlerStack } from '../lib/crawler-stack';

const app = new cdk.App();

// Get the crawler bucket name from context (REQUIRED for fresh deployments)
const crawlerBucketName = app.node.tryGetContext('crawlerBucketName');
if (!crawlerBucketName) {
  throw new Error(
    'Missing required context: crawlerBucketName\n' +
    'Provide via: cdk deploy -c crawlerBucketName=your-bucket-name\n' +
    'This must be an existing S3 bucket that will be used for both crawler output and Bedrock KB data source.'
  );
}

// Deploy the Crawler Stack (ECS infrastructure)
const crawlerStack = new CrawlerStack(app, 'AskUSDA-Crawler', {
  crawlerBucketName,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-west-2',
  },
});

// Deploy the Backend Stack (Chatbot, KB, Lambda, etc.)
// Pass crawler infrastructure references from the crawler stack
new USDAChatbotStack(app, 'AskUSDA-Backend', {
  crawlerStack,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
