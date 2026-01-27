#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { USDAChatbotStack } from '../lib/backend-stack';

const app = new cdk.App();
new USDAChatbotStack(app, 'AskUSDA-Backend', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
