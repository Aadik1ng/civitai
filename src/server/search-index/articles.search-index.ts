import { client } from '~/server/meilisearch/client';
import {
  getOrCreateIndex,
  onSearchIndexDocumentsCleanup,
  waitForTasksWithRetries,
} from '~/server/meilisearch/util';
import { EnqueuedTask } from 'meilisearch';
import {
  createSearchIndexUpdateProcessor,
  SearchIndexRunContext,
} from '~/server/search-index/base.search-index';
import { MetricTimeframe, Prisma, PrismaClient } from '@prisma/client';
import { articleDetailSelect } from '~/server/selectors/article.selector';

const READ_BATCH_SIZE = 1000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 25;
const INDEX_ID = 'articles';
const SWAP_INDEX_ID = `${INDEX_ID}_NEW`;

const onIndexSetup = async ({ indexName }: { indexName: string }) => {
  if (!client) {
    return;
  }

  const index = await getOrCreateIndex(indexName, { primaryKey: 'id' });
  console.log('onIndexSetup :: Index has been gotten or created', index);

  if (!index) {
    return;
  }

  const settings = await index.getSettings();

  const updateSearchableAttributesTask = await index.updateSearchableAttributes([
    'title',
    'content',
    'tags',
    'user.username',
  ]);

  console.log(
    'onIndexSetup :: updateSearchableAttributesTask created',
    updateSearchableAttributesTask
  );

  const sortableFieldsAttributesTask = await index.updateSortableAttributes([
    'createdAt',
    'metrics.commentCount',
    'metrics.favoriteCount',
    'metrics.viewCount',
  ]);

  console.log('onIndexSetup :: sortableFieldsAttributesTask created', sortableFieldsAttributesTask);

  const filterableAttributes = ['tags'];

  if (
    // Meilisearch stores sorted.
    JSON.stringify(filterableAttributes.sort()) !== JSON.stringify(settings.filterableAttributes)
  ) {
    const updateFilterableAttributesTask = await index.updateFilterableAttributes(
      filterableAttributes
    );

    console.log(
      'onIndexSetup :: updateFilterableAttributesTask created',
      updateFilterableAttributesTask
    );
  }

  console.log('onIndexSetup :: all tasks completed');
};

export type ArticleSearchIndexRecord = Awaited<ReturnType<typeof onFetchItemsToIndex>>[number];

const onFetchItemsToIndex = async ({
  db,
  whereOr,
  indexName,
  ...queryProps
}: {
  db: PrismaClient;
  indexName: string;
  whereOr?: Prisma.Enumerable<Prisma.ArticleWhereInput>;
  skip?: number;
  take?: number;
}) => {
  const offset = queryProps.skip || 0;
  console.log(
    `onFetchItemsToIndex :: fetching starting for ${indexName} range:`,
    offset,
    offset + READ_BATCH_SIZE - 1,
    ' filters:',
    whereOr
  );

  const articles = await db.article.findMany({
    skip: offset,
    take: READ_BATCH_SIZE,
    select: {
      ...articleDetailSelect,
      metrics: {
        select: {
          commentCount: true,
          cryCount: true,
          dislikeCount: true,
          favoriteCount: true,
          heartCount: true,
          hideCount: true,
          laughCount: true,
          viewCount: true,
          likeCount: true,
        },
        where: {
          timeframe: MetricTimeframe.AllTime,
        },
      },
    },
    where: {
      publishedAt: {
        not: null,
      },
      tosViolation: false,
      // if lastUpdatedAt is not provided,
      // this should generate the entirety of the index.
      OR: whereOr,
    },
  });

  console.log(
    `onFetchItemsToIndex :: fetching complete for ${indexName} range:`,
    offset,
    offset + READ_BATCH_SIZE - 1,
    'filters:',
    whereOr
  );

  // Avoids hitting the DB without data.
  if (articles.length === 0) {
    return [];
  }

  const indexReadyRecords = articles.map(({ tags, ...articleRecord }) => {
    return {
      ...articleRecord,
      metrics: {
        // Flattens metric array
        ...(articleRecord.metrics[0] || {}),
      },
      // Flatten tags:
      tags: tags.map((articleTag) => articleTag.tag.name),
    };
  });

  return indexReadyRecords;
};

const onIndexUpdate = async ({ db, lastUpdatedAt, indexName }: SearchIndexRunContext) => {
  if (!client) return;

  // Confirm index setup & working:
  await onIndexSetup({ indexName });
  // Cleanup documents that require deletion:
  // Always pass INDEX_ID here, not index name, as pending to delete will
  // always use this name.
  await onSearchIndexDocumentsCleanup({ db, indexName: INDEX_ID });

  let offset = 0;
  const articlesTasks: EnqueuedTask[] = [];

  const queuedItems = await db.searchIndexUpdateQueue.findMany({
    select: {
      id: true,
    },
    where: {
      type: INDEX_ID,
    },
  });

  while (true) {
    console.log(
      `onIndexUpdate :: fetching starting for ${indexName} range:`,
      offset,
      offset + READ_BATCH_SIZE - 1
    );
    const indexReadyRecords = await onFetchItemsToIndex({
      db,
      indexName,
      skip: offset,
      whereOr: !lastUpdatedAt
        ? undefined
        : [
            {
              createdAt: {
                gt: lastUpdatedAt,
              },
            },
            {
              updatedAt: {
                gt: lastUpdatedAt,
              },
            },
            {
              id: {
                in: queuedItems.map(({ id }) => id),
              },
            },
          ],
    });
    console.log(
      `onIndexUpdate :: fetching complete for ${indexName} range:`,
      offset,
      offset + READ_BATCH_SIZE - 1
    );

    if (indexReadyRecords.length === 0) break;

    const tasks = await client
      .index(indexName)
      .updateDocumentsInBatches(indexReadyRecords, MEILISEARCH_DOCUMENT_BATCH_SIZE);
    articlesTasks.push(...tasks);

    offset += indexReadyRecords.length;
  }

  console.log('onIndexUpdate :: start waitForTasks');
  await waitForTasksWithRetries(articlesTasks.map((task) => task.taskUid));
  console.log('onIndexUpdate :: complete waitForTasks');
};

export const articlesSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  swapIndexName: SWAP_INDEX_ID,
  onIndexUpdate,
  onIndexSetup,
});
