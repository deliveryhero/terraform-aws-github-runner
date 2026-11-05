import { EC2, SSM } from 'aws-sdk';

import { LogFields, logger as rootLogger } from '../logger';
import ScaleError from './../scale-runners/ScaleError';

const logger = rootLogger.getChildLogger({ name: 'runners' });

export interface RunnerList {
  instanceId: string;
  launchTime?: Date;
  owner?: string;
  type?: string;
  repo?: string;
  org?: string;
}

export interface RunnerInfo {
  instanceId: string;
  launchTime?: Date;
  owner: string;
  type: string;
}

export interface ListRunnerFilters {
  runnerType?: 'Org' | 'Repo';
  runnerOwner?: string;
  environment?: string;
  statuses?: string[];
}

export interface RunnerInputParameters {
  runnerServiceConfig: string[];
  environment: string;
  runnerType: 'Org' | 'Repo';
  runnerOwner: string;
  subnets: string[];
  launchTemplateName: string;
  ec2instanceCriteria: {
    instanceTypes: string[];
    targetCapacityType: EC2.DefaultTargetCapacityType;
    maxSpotPrice?: string;
    instanceAllocationStrategy: EC2.SpotAllocationStrategy;
  };
  numberOfRunners?: number;
}

export async function listEC2Runners(filters: ListRunnerFilters | undefined = undefined): Promise<RunnerList[]> {
  const ec2Statuses = filters?.statuses ? filters.statuses : ['running', 'pending'];
  const ec2 = new EC2();
  const ec2Filters = [
    { Name: 'tag:Application', Values: ['github-action-runner'] },
    { Name: 'instance-state-name', Values: ec2Statuses },
  ];

  if (filters) {
    if (filters.environment !== undefined) {
      ec2Filters.push({ Name: 'tag:ghr:environment', Values: [filters.environment] });
    }
    if (filters.runnerType && filters.runnerOwner) {
      ec2Filters.push({ Name: `tag:Type`, Values: [filters.runnerType] });
      ec2Filters.push({ Name: `tag:Owner`, Values: [filters.runnerOwner] });
    }
  }

  const runners: RunnerList[] = [];
  let nextToken;
  let hasNext = true;
  while (hasNext) {
    const runningInstances: EC2.DescribeInstancesResult = await ec2
      .describeInstances({ Filters: ec2Filters, NextToken: nextToken })
      .promise();
    hasNext = runningInstances.NextToken ? true : false;
    nextToken = runningInstances.NextToken;
    runners.push(...getRunnerInfo(runningInstances));
  }
  return runners;
}

function getRunnerInfo(runningInstances: EC2.DescribeInstancesResult) {
  const runners: RunnerList[] = [];
  if (runningInstances.Reservations) {
    for (const r of runningInstances.Reservations) {
      if (r.Instances) {
        for (const i of r.Instances) {
          runners.push({
            instanceId: i.InstanceId as string,
            launchTime: i.LaunchTime,
            owner: i.Tags?.find((e) => e.Key === 'Owner')?.Value as string,
            type: i.Tags?.find((e) => e.Key === 'Type')?.Value as string,
            repo: i.Tags?.find((e) => e.Key === 'Repo')?.Value as string,
            org: i.Tags?.find((e) => e.Key === 'Org')?.Value as string,
          });
        }
      }
    }
  }
  return runners;
}

export async function terminateRunner(instanceId: string): Promise<void> {
  const ec2 = new EC2();
  await ec2
    .terminateInstances({
      InstanceIds: [instanceId],
    })
    .promise();
  logger.info(`Runner ${instanceId} has been terminated.`, LogFields.print());
}

function generateFleeOverrides(
  subnetIds: string[],
  instancesTypes: string[],
): EC2.FleetLaunchTemplateOverridesListRequest {
  const result: EC2.FleetLaunchTemplateOverridesListRequest = [];
  subnetIds.forEach((s) => {
    instancesTypes.forEach((i) => {
      result.push({
        SubnetId: s,
        InstanceType: i,
      });
    });
  });
  return result;
}

interface LaunchTemplateTags {
  instance: EC2.TagList;
  volume: EC2.TagList;
}

// The launch template carries the tags defined in Terraform (e.g. runner_ec2_tags). CreateFleet requests that
// specify TagSpecifications are evaluated on their own, so organization policies checking aws:RequestTag
// (mandatory-tag SCPs) do not see the template tags. Read them and send them with the request.
// Requires ec2:DescribeLaunchTemplateVersions; on any failure the request is sent exactly as before.
async function getLaunchTemplateTags(ec2: EC2, launchTemplateName: string): Promise<LaunchTemplateTags> {
  try {
    const result = await ec2
      .describeLaunchTemplateVersions({ LaunchTemplateName: launchTemplateName, Versions: ['$Default'] })
      .promise();
    const specs = result.LaunchTemplateVersions?.[0]?.LaunchTemplateData?.TagSpecifications || [];
    const tagsFor = (type: string): EC2.TagList => specs.find((spec) => spec.ResourceType === type)?.Tags || [];
    return { instance: tagsFor('instance'), volume: tagsFor('volume') };
  } catch (e) {
    logger.warn('Unable to read tags from the launch template, only module-owned tags are sent.', e);
    return { instance: [], volume: [] };
  }
}

// Template tags first, module-owned tags last so they always win.
function mergeTags(templateTags: EC2.TagList, ownTags: EC2.TagList): EC2.TagList {
  const merged = new Map<string, string>();
  for (const { Key, Value } of templateTags) {
    if (Key !== undefined) merged.set(Key, Value ?? '');
  }
  for (const { Key, Value } of ownTags) {
    if (Key !== undefined) merged.set(Key, Value ?? '');
  }
  return Array.from(merged, ([Key, Value]) => ({ Key, Value }));
}

export async function createRunner(runnerParameters: RunnerInputParameters): Promise<void> {
  logger.debug('Runner configuration: ' + JSON.stringify(runnerParameters), LogFields.print());

  const ec2 = new EC2();
  const numberOfRunners = runnerParameters.numberOfRunners ? runnerParameters.numberOfRunners : 1;

  const templateTags = await getLaunchTemplateTags(ec2, runnerParameters.launchTemplateName);
  const tagSpecifications: EC2.TagSpecificationList = [
    {
      ResourceType: 'instance',
      Tags: mergeTags(templateTags.instance, [
        { Key: 'Application', Value: 'github-action-runner' },
        { Key: 'Type', Value: runnerParameters.runnerType },
        { Key: 'Owner', Value: runnerParameters.runnerOwner },
      ]),
    },
  ];
  // The v1.2.0 launch template only puts runner_ec2_tags on instances; volumes created by the fleet need
  // the same mandatory tags, so send the template's volume tags plus the instance template tags (minus Name).
  const volumeTags = mergeTags(
    templateTags.instance.filter((t) => t.Key !== 'Name'),
    templateTags.volume,
  );
  if (templateTags.instance.length > 0 || templateTags.volume.length > 0) {
    tagSpecifications.push({ ResourceType: 'volume', Tags: volumeTags });
  }

  let fleet: AWS.EC2.CreateFleetResult;
  try {
    // see for spec https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CreateFleet.html
    fleet = await ec2
      .createFleet({
        LaunchTemplateConfigs: [
          {
            LaunchTemplateSpecification: {
              LaunchTemplateName: runnerParameters.launchTemplateName,
              Version: '$Default',
            },
            Overrides: generateFleeOverrides(
              runnerParameters.subnets,
              runnerParameters.ec2instanceCriteria.instanceTypes,
            ),
          },
        ],
        SpotOptions: {
          MaxTotalPrice: runnerParameters.ec2instanceCriteria.maxSpotPrice,
          AllocationStrategy: 'capacity-optimized',
        },
        TargetCapacitySpecification: {
          TotalTargetCapacity: numberOfRunners,
          DefaultTargetCapacityType: runnerParameters.ec2instanceCriteria.targetCapacityType,
        },
        TagSpecifications: tagSpecifications,
        Type: 'instant',
      })
      .promise();
  } catch (e) {
    logger.warn('Create fleet request failed.', e);
    throw e;
  }

  const instances: string[] = fleet.Instances?.flatMap((i) => i.InstanceIds?.flatMap((j) => j) || []) || [];

  if (instances.length === 0) {
    logger.warn(`No instances created by fleet request. Check configuration! Response:`, fleet);
    const errors = fleet.Errors?.flatMap((e) => e.ErrorCode || '') || [];

    // Educated guess of errors that would make sense to retry based on the list
    // https://docs.aws.amazon.com/AWSEC2/latest/APIReference/errors-overview.html
    const scaleErrors = [
      'UnfulfillableCapacity',
      'MaxSpotInstanceCountExceeded',
      'TargetCapacityLimitExceededException',
      'RequestLimitExceeded',
      'ResourceLimitExceeded',
      'MaxSpotInstanceCountExceeded',
      'MaxSpotFleetRequestCountExceeded',
    ];

    if (errors.some((e) => scaleErrors.includes(e))) {
      logger.warn('Create fleet failed, ScaleError will be thrown to trigger retry for ephemeral runners.');
      logger.debug('Create fleet failed.', fleet.Errors);
      throw new ScaleError('Failed to create instance, create fleet failed.');
    } else {
      logger.warn('Create fleet failed, error not recognized as scaling error.', fleet.Errors);
      throw Error('Create fleet failed, no instance created.');
    }
  }

  logger.info('Created instance(s): ', instances.join(','), LogFields.print());

  const ssm = new SSM();
  for (const instance of instances) {
    await ssm
      .putParameter({
        Name: `${runnerParameters.environment}-${instance}`,
        Value: runnerParameters.runnerServiceConfig.join(' '),
        Type: 'SecureString',
      })
      .promise();
  }
}
