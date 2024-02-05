import * as path from "path";
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecrdeploy from "cdk-ecr-deployment";
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

export class BlogEcsTasksSelectivelyLeverageSociStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // VPC
    const vpc = new ec2.Vpc(this, 'vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        }
      ],
      vpcName: 'soci-update-vpc',
      enableDnsHostnames: true,
      enableDnsSupport: true,
      natGatewaySubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // ECR (Nginx)
    const nginxRepo = new ecr.Repository(this, 'nginxRepo', {
      repositoryName: 'nginx-repo',
      imageScanOnPush: true,
      emptyOnDelete: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const nginxAsset = new DockerImageAsset(this, 'nginxDockerImage', {
      directory: path.join(__dirname, "..", "app/nginx"),
      platform: Platform.LINUX_ARM64
    });

    new ecrdeploy.ECRDeployment(this, "nginxDeployment", {
      src: new ecrdeploy.DockerImageName(nginxAsset.imageUri),
      dest: new ecrdeploy.DockerImageName(`${nginxRepo.repositoryUri}:latest`),
    });

    // ECR (FireLens)
    const firelensRepo = new ecr.Repository(this, 'firelensRepo', {
      repositoryName: 'firelens-repo',
      imageScanOnPush: true,
      emptyOnDelete: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const firelensAsset = new DockerImageAsset(this, 'firelensDockerImage', {
      directory: path.join(__dirname, "..", "app/firelens"),
      platform: Platform.LINUX_ARM64
    });

    new ecrdeploy.ECRDeployment(this, "firelensDeployment", {
      src: new ecrdeploy.DockerImageName(firelensAsset.imageUri),
      dest: new ecrdeploy.DockerImageName(`${firelensRepo.repositoryUri}:latest`),
    });

    const taskRole = new iam.Role(this, 'taskRole', {
      roleName: 'soci-update-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Task Role
    const taskPolicy = new iam.ManagedPolicy(this, 'taskPolicy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'RoleForECSExec',
          effect: iam.Effect.ALLOW,
          actions: [
            "ssmmessages:CreateControlChannel",
            "ssmmessages:CreateDataChannel",
            "ssmmessages:OpenControlChannel",
            "ssmmessages:OpenDataChannel"
          ],
          resources: ['*']
        }),
        new iam.PolicyStatement({
          sid: 'RoleForCloudWatchLogs',
          effect: iam.Effect.ALLOW,
          actions: [
            "logs:CreateLogStream",
            "logs:PutLogEvents"
          ],
          resources: ['*']
        })
      ]
    });
    taskRole.addManagedPolicy(taskPolicy);

    // Task Exec Role
    const executionRole = new iam.Role(this, 'executionRole', {
      roleName: 'soci-update-task-exec-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
      ]
    });

    // Log Group
    new logs.LogGroup(this, 'nginxLogGroup', {
      logGroupName: 'soci-update-nginx-log-group',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const firelensLogGroup = new logs.LogGroup(this, 'firelensLogGroup', {
      logGroupName: 'soci-update-firelens-log-group',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    } );

    // Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'taskDefinition', {
      family: 'soci-update-task-definition',
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
      },
      taskRole,
      executionRole,
    });

    taskDefinition.addContainer('nginxContainer', {
      essential: true,
      image: ecs.ContainerImage.fromEcrRepository(nginxRepo),
      containerName: 'nginxContainer',
      portMappings: [{
        containerPort: 80,
        hostPort: 80,
        protocol: ecs.Protocol.TCP
      }],
      logging: ecs.LogDrivers.firelens({}),
      linuxParameters: new ecs.LinuxParameters(this, 'nginxLinuxParameters', {
        initProcessEnabled: true,
      }),
    });

    taskDefinition.addFirelensLogRouter('firelensContainer', {
      essential: true,
      image: ecs.ContainerImage.fromEcrRepository(firelensRepo),
      containerName: 'firelensContainer',
      firelensConfig: {
        type: ecs.FirelensLogRouterType.FLUENTBIT,
        options: {
          enableECSLogMetadata: true,
          configFileType: ecs.FirelensConfigFileType.FILE,
          configFileValue: "/fluent-bit/etc/extra.conf"
        },
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'firelens',
        logGroup: firelensLogGroup
      }),
      readonlyRootFilesystem: true,
      linuxParameters: new ecs.LinuxParameters(this, 'nginxLinuxParameters', {
        initProcessEnabled: true,
      }),
    });

    // ALB
    const albSg = new ec2.SecurityGroup(this, 'albSg', {
      vpc,
      securityGroupName: 'soci-update-alb-sg',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(),ec2.Port.tcp(80),);

    const tg = new elbv2.ApplicationTargetGroup(this, 'tg', {
      targetGroupName: 'soci-update-tg',
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: cdk.Duration.seconds(60),
      healthCheck: {
        path: '/',
        port: 'traffic-port',
        protocol: elbv2.Protocol.HTTP,
      },
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'alb', {
      vpc,
      internetFacing: true,
      loadBalancerName: 'soci-update-alb',
      dropInvalidHeaderFields: true,
      deletionProtection: false,
      http2Enabled: true,
      idleTimeout: cdk.Duration.seconds(60),
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC
      },
      securityGroup: albSg,
    });
    
    alb.addListener('albListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.forward([tg]),
      open: true,
    });

    // ECS
    const ecsSg = new ec2.SecurityGroup(this, 'ecsSg', {
      vpc,
      securityGroupName: 'soci-update-ecs-sg',
      allowAllOutbound: true,
    });
    ecsSg.addIngressRule(ec2.Peer.securityGroupId(albSg.securityGroupId),ec2.Port.tcp(80),);

    const cluster = new ecs.Cluster(this, 'cluster', {
      vpc,
      clusterName: 'soci-update-cluster',
    });

    new ecs.FargateService(this, 'service', {
      serviceName: 'soci-update-service',
      cluster,
      taskDefinition,
      desiredCount: 1,
      enableECSManagedTags: true,
      enableExecuteCommand: true,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      securityGroups: [
        ecsSg,
      ],
    });
  }
}
