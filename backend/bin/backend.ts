#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { USDAChatbotStack } from '../lib/backend-stack';
import { CrawlerStack } from '../lib/crawler-stack';

const app = new cdk.App();

// Get the crawler bucket name from context or use the existing one
const crawlerBucketName = app.node.tryGetContext('crawlerBucketName') || 'webcrawlerstack-crawlerdatabucketea3cc496-exqm1c1h8tiz';

// Deploy the Crawler Stack (ECS infrastructure)
const crawlerStack = new CrawlerStack(app, 'AskUSDA-Crawler', {
  crawlerBucketName,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-west-2',
  },
});

// Deploy the Backend Stack (Chatbot, KB, Lambda, etc.)
new USDAChatbotStack(app, 'AskUSDA-Backend', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
