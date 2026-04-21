#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { USDAChatbotStack } from '../lib/backend-stack';
import { CrawlerStack } from '../lib/crawler-stack';

const app = new cdk.App();

// Optional: Use existing bucket, otherwise CrawlerStack creates one
const crawlerBucketName = app.node.tryGetContext('crawlerBucketName');

// Deploy the Crawler Stack (ECS infrastructure)
const crawlerStack = new CrawlerStack(app, 'AskUSDA-Crawler', {
  crawlerBucketName, // undefined = create new bucket
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
