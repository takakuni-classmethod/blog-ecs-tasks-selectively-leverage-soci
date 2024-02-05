#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BlogEcsTasksSelectivelyLeverageSociStack } from '../lib/blog-ecs-tasks-selectively-leverage-soci-stack';

const app = new cdk.App();
new BlogEcsTasksSelectivelyLeverageSociStack(app, 'BlogEcsTasksSelectivelyLeverageSociStack', {
  env: {
    account: process.env.AWS_ACCOUNT_ID,
    region: process.env.AWS_DEFAULT_REGION
  }
});