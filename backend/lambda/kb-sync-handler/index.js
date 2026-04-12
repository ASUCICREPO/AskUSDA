const { BedrockAgentClient, StartIngestionJobCommand } = require('@aws-sdk/client-bedrock-agent');
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs');
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, CopyObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const bedrockClient = new BedrockAgentClient({});
const ecsClient = new ECSClient({ region: process.env.CRAWLER_REGION || 'us-west-2' });
const s3Client = new S3Client({ region: process.env.CRAWLER_REGION || 'us-west-2' });

const BUCKET = process.env.CRAWLER_BUCKET;
const INGESTION_PREFIX = 'ingestion/';
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB — Bedrock's hard limit

// Crawler infrastructure files that should never be ingested
const JUNK_FILES = new Set(['status.json', 'manifest.json', 'job_summary.json', 'crawl_report.csv']);

// Content file extensions that Bedrock can meaningfully parse.
// Excluded: .ppt (legacy, unsupported by Bedrock), .csv (rarely useful as knowledge)
const CONTENT_EXTENSIONS = new Set([
  '.md', '.pdf', '.txt', '.html', '.htm',
  '.doc', '.docx', '.xls', '.xlsx',
  '.pptx', '.PDF',
]);

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

// Read a crawler metadata file and return the parsed JSON
async function readCrawlerMetadata(metadataKey) {
  try {
    const resp = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: metadataKey }));
    return JSON.parse(await streamToString(resp.Body));
  } catch {
    return null;
  }
}

// Convert crawler metadata to Bedrock metadata format
function toBedrock(raw) {
  const attrs = {};
  if (raw.source_url) attrs.source_url = raw.source_url;
  if (raw.title) attrs.title = raw.title;
  if (raw.domain) attrs.domain = raw.domain;
  if (raw.path) attrs.path = raw.path;
  return { metadataAttributes: attrs };
}

// Check if a file extension is a content type we want to ingest
function isContentFile(key) {
  const filename = key.split('/').pop();
  if (JUNK_FILES.has(filename)) return false;
  if (filename.endsWith('.metadata.json')) return false;
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return false;
  return CONTENT_EXTENSIONS.has(filename.substring(lastDot));
}

// S3 copy (server-side, no data transfer)
// CopySource requires URL-encoding because it's passed as an HTTP header
async function s3Copy(sourceKey, destKey) {
  const encodedSource = `${BUCKET}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`;
  await s3Client.send(new CopyObjectCommand({
    Bucket: BUCKET,
    CopySource: encodedSource,
    Key: destKey,
  }));
}

// Write Bedrock metadata JSON next to a content file in the ingestion prefix
async function writeBedrockMetadata(destKey, bedrockMeta) {
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: destKey + '.metadata.json',
    Body: JSON.stringify(bedrockMeta),
    ContentType: 'application/json',
  }));
}

// Build a dedup key from source_url or filename to avoid duplicates across jobs
function dedupKey(sourceUrl, filename) {
  return sourceUrl || filename;
}

/**
 * Main pipeline: scan all crawler jobs, copy content files + metadata into
 * a clean ingestion/ prefix that Bedrock's S3 data source points at.
 *
 * Structure produced:
 *   ingestion/markdown/{hash}.md                  + .metadata.json
 *   ingestion/pdfs/{filename}.pdf                 + .metadata.json
 *   ingestion/docs/{filename}.xlsx                + .metadata.json
 */
async function prepareIngestion() {
  console.log('[PREPARE] Starting ingestion preparation for bucket:', BUCKET);
  const stats = { copied: 0, metadataWritten: 0, skipped: 0, duplicates: 0, oversized: 0, errors: 0 };
  const seen = new Set(); // dedup tracker

  // List all job prefixes
  const jobsResp = await s3Client.send(new ListObjectsV2Command({
    Bucket: BUCKET, Prefix: 'jobs/', Delimiter: '/',
  }));
  const jobPrefixes = (jobsResp.CommonPrefixes || []).map(p => p.Prefix);
  console.log('[PREPARE] Found', jobPrefixes.length, 'job directories');

  for (const jobPrefix of jobPrefixes) {
    console.log('[PREPARE] Processing job:', jobPrefix);
    await processMarkdown(jobPrefix, seen, stats);
    await processPdfs(jobPrefix, seen, stats);
    await processDocs(jobPrefix, seen, stats);
  }

  console.log('[PREPARE] Done:', JSON.stringify(stats));
  return stats;
}

// Process markdown files: jobs/{id}/all/markdown/*.md
async function processMarkdown(jobPrefix, seen, stats) {
  const contentPrefix = jobPrefix + 'all/markdown/';
  const metadataPrefix = jobPrefix + 'all/metadata/';
  let token;

  do {
    const listResp = await s3Client.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: contentPrefix, ContinuationToken: token, MaxKeys: 500,
    }));
    token = listResp.NextContinuationToken;
    const files = (listResp.Contents || []).filter(o => o.Key.endsWith('.md') && !o.Key.endsWith('.metadata.json'));

    for (let i = 0; i < files.length; i += 25) {
      const batch = files.slice(i, i + 25);
      await Promise.all(batch.map(async (obj) => {
        try {
          if (obj.Size > MAX_FILE_SIZE) {
            console.warn('[PREPARE] Skipping oversized markdown:', obj.Key, `(${(obj.Size / 1024 / 1024).toFixed(1)}MB)`);
            stats.oversized++;
            return;
          }
          const filename = obj.Key.split('/').pop();
          const metaKey = metadataPrefix + filename + '.metadata.json';
          const raw = await readCrawlerMetadata(metaKey);

          const dk = dedupKey(raw?.source_url, filename);
          if (seen.has(dk)) { stats.duplicates++; return; }
          seen.add(dk);

          const destKey = INGESTION_PREFIX + 'markdown/' + filename;
          await s3Copy(obj.Key, destKey);
          stats.copied++;

          if (raw) {
            await writeBedrockMetadata(destKey, toBedrock(raw));
            stats.metadataWritten++;
          }
        } catch (err) {
          console.warn('[PREPARE] Error processing markdown:', obj.Key, err.message);
          stats.errors++;
        }
      }));
    }
  } while (token);
}

// Process PDF files: jobs/{id}/pdfs/*.pdf
async function processPdfs(jobPrefix, seen, stats) {
  const contentPrefix = jobPrefix + 'pdfs/';
  const metadataPrefix = jobPrefix + 'pdfs/metadata/';
  let token;

  do {
    const listResp = await s3Client.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: contentPrefix, ContinuationToken: token, MaxKeys: 500,
    }));
    token = listResp.NextContinuationToken;
    const files = (listResp.Contents || []).filter(o => {
      const name = o.Key.split('/').pop();
      return !name.endsWith('.metadata.json') && !o.Key.includes('/metadata/');
    });

    for (let i = 0; i < files.length; i += 25) {
      const batch = files.slice(i, i + 25);
      await Promise.all(batch.map(async (obj) => {
        try {
          if (obj.Size > MAX_FILE_SIZE) {
            console.warn('[PREPARE] Skipping oversized PDF:', obj.Key, `(${(obj.Size / 1024 / 1024).toFixed(1)}MB)`);
            stats.oversized++;
            return;
          }
          const filename = obj.Key.split('/').pop();
          const metaKey = metadataPrefix + filename + '.metadata.json';
          const raw = await readCrawlerMetadata(metaKey);

          const dk = dedupKey(raw?.source_url, filename);
          if (seen.has(dk)) { stats.duplicates++; return; }
          seen.add(dk);

          const destKey = INGESTION_PREFIX + 'pdfs/' + filename;
          await s3Copy(obj.Key, destKey);
          stats.copied++;

          if (raw) {
            await writeBedrockMetadata(destKey, toBedrock(raw));
            stats.metadataWritten++;
          }
        } catch (err) {
          console.warn('[PREPARE] Error processing PDF:', obj.Key, err.message);
          stats.errors++;
        }
      }));
    }
  } while (token);
}

// Process doc files: jobs/{id}/docs/*.xlsx, *.xls, *.doc, *.docx, etc.
async function processDocs(jobPrefix, seen, stats) {
  const contentPrefix = jobPrefix + 'docs/';
  const metadataPrefix = jobPrefix + 'docs/metadata/';
  let token;

  do {
    const listResp = await s3Client.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: contentPrefix, ContinuationToken: token, MaxKeys: 500,
    }));
    token = listResp.NextContinuationToken;
    const files = (listResp.Contents || []).filter(o => {
      const name = o.Key.split('/').pop();
      return isContentFile(o.Key) && !o.Key.includes('/metadata/');
    });

    for (let i = 0; i < files.length; i += 25) {
      const batch = files.slice(i, i + 25);
      await Promise.all(batch.map(async (obj) => {
        try {
          if (obj.Size > MAX_FILE_SIZE) {
            console.warn('[PREPARE] Skipping oversized doc:', obj.Key, `(${(obj.Size / 1024 / 1024).toFixed(1)}MB)`);
            stats.oversized++;
            return;
          }
          const filename = obj.Key.split('/').pop();
          const metaKey = metadataPrefix + filename + '.metadata.json';
          const raw = await readCrawlerMetadata(metaKey);

          const dk = dedupKey(raw?.source_url, filename);
          if (seen.has(dk)) { stats.duplicates++; return; }
          seen.add(dk);

          const destKey = INGESTION_PREFIX + 'docs/' + filename;
          await s3Copy(obj.Key, destKey);
          stats.copied++;

          if (raw) {
            await writeBedrockMetadata(destKey, toBedrock(raw));
            stats.metadataWritten++;
          }
        } catch (err) {
          console.warn('[PREPARE] Error processing doc:', obj.Key, err.message);
          stats.errors++;
        }
      }));
    }
  } while (token);
}

// Trigger ECS crawler task
async function triggerCrawl(event) {
  const url = event.url || 'https://www.usda.gov/about-food/';
  const maxPages = event.maxPages || '500';
  const scopeType = event.scopeType || 'host';
  const jobId = event.jobId || '';

  const overrides = [
    { name: 'SEED_URL', value: url },
    { name: 'MAX_PAGES', value: String(maxPages) },
    { name: 'SCOPE_TYPE', value: scopeType },
    { name: 'USE_BROWSER', value: 'on' },
    { name: 'PDF_SCOPE', value: 'all' },
    { name: 'DOC_SCOPE', value: 'all' },
  ];
  if (jobId) overrides.push({ name: 'JOB_ID', value: jobId });

  const subnets = (process.env.CRAWLER_SUBNETS || '').split(',').filter(Boolean);
  const resp = await ecsClient.send(new RunTaskCommand({
    cluster: process.env.CRAWLER_CLUSTER_ARN,
    taskDefinition: process.env.CRAWLER_TASK_DEF_ARN,
    launchType: 'FARGATE',
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets,
        securityGroups: [process.env.CRAWLER_SG_ID],
        assignPublicIp: 'ENABLED',
      },
    },
    overrides: {
      containerOverrides: [{
        name: process.env.CRAWLER_CONTAINER_NAME,
        environment: overrides,
      }],
    },
  }));

  const taskArn = resp.tasks?.[0]?.taskArn || 'unknown';
  console.log('Crawl task started:', taskArn);
  return { status: 'crawl_started', taskArn, url };
}

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  const action = event.action || 'ingest';

  if (action === 'crawl') {
    return triggerCrawl(event);
  }

  if (action === 'prepare') {
    const result = await prepareIngestion();
    return { status: 'prepare_complete', ...result };
  }

  // Default: ingest = prepare + start Bedrock ingestion on the v2 data source (default parsing).
  // Default parsing has no per-job file limit, so all files are processed in one go.
  const prepResult = await prepareIngestion();
  console.log('[INGEST] Preparation result:', prepResult);

  const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID;
  const dataSourceId = process.env.DATA_SOURCE_ID;

  console.log('[INGEST] Starting ingestion for data source:', dataSourceId);
  const response = await bedrockClient.send(new StartIngestionJobCommand({ knowledgeBaseId, dataSourceId }));
  const ingestionJobId = response.ingestionJob?.ingestionJobId;
  console.log('[INGEST] Ingestion started, job ID:', ingestionJobId);

  return {
    status: 'ingestion_started',
    ingestionJobId,
    preparation: prepResult,
  };
};
