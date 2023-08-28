import { Box, Center, Loader, Stack, Text, ThemeIcon, Title, UnstyledButton } from '@mantine/core';
import {
  createContext,
  Dispatch,
  SetStateAction,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useInfiniteHits, useInstantSearch } from 'react-instantsearch';
import { useInView } from 'react-intersection-observer';
import { ImageCard, UnroutedImageCard } from '~/components/Cards/ImageCard';
import {
  SearchableMultiSelectRefinementList,
  SortBy,
} from '~/components/Search/CustomSearchComponents';
import { ImageSearchIndexRecord } from '~/server/search-index/images.search-index';
import { SearchHeader } from '~/components/Search/SearchHeader';
import { SearchLayout, useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { IconCloudOff } from '@tabler/icons-react';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { isDefined } from '~/utils/type-guards';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { applyUserPreferencesImages } from '~/components/Search/search.utils';
import { constants, IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { ImagesSearchIndexSortBy } from '~/components/Search/parsers/image.parser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { CollectionContributorPermission, MetricTimeframe } from '@prisma/client';
import { useHotkeys } from '@mantine/hooks';
import { ImageDetailByProps } from '~/components/Image/Detail/ImageDetailByProps';
import { z } from 'zod';
import { periodModeSchema } from '~/server/schema/base.schema';
import { ModelSort } from '~/server/common/enums';
import { usernameSchema } from '~/server/schema/user.schema';
import { postgresSlugify } from '~/utils/string-helpers';

export default function ImageSearch() {
  return (
    <SearchLayout.Root>
      <SearchLayout.Filters>
        <RenderFilters />
      </SearchLayout.Filters>
      <SearchLayout.Content>
        <SearchHeader />
        <ImagesHitList />
      </SearchLayout.Content>
    </SearchLayout.Root>
  );
}

function RenderFilters() {
  return (
    <>
      <SortBy
        title="Sort images by"
        items={[
          { label: 'Relevancy', value: ImagesSearchIndexSortBy[0] as string },
          { label: 'Most Reactions', value: ImagesSearchIndexSortBy[1] as string },
          { label: 'Most Discussed', value: ImagesSearchIndexSortBy[2] as string },
          { label: 'Newest', value: ImagesSearchIndexSortBy[3] as string },
        ]}
      />
      <SearchableMultiSelectRefinementList
        title="Users"
        attribute="user.username"
        sortBy={['count:desc']}
        searchable={true}
      />
      <SearchableMultiSelectRefinementList
        title="Tags"
        attribute="tags.name"
        operator="and"
        sortBy={['count:desc']}
        searchable={true}
      />
    </>
  );
}

function ImagesHitList() {
  const { classes } = useSearchLayoutStyles();
  const { status } = useInstantSearch();
  const { ref, inView } = useInView();

  const { hits, showMore, isLastPage } = useInfiniteHits<ImageSearchIndexRecord>();
  const router = useRouter();
  const currentUser = useCurrentUser();
  const {
    images: hiddenImages,
    tags: hiddenTags,
    users: hiddenUsers,
    isLoading: loadingPreferences,
  } = useHiddenPreferencesContext();

  const images = useMemo(() => {
    return applyUserPreferencesImages<ImageSearchIndexRecord>({
      items: hits,
      hiddenImages,
      hiddenTags,
      hiddenUsers,
      currentUserId: currentUser?.id,
    });
  }, [hits, hiddenImages, hiddenTags, hiddenUsers, currentUser]);

  const hiddenItems = hits.length - images.length;

  const { onSetImage } = useImageViewerCtx({ images });

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView && status === 'idle' && !isLastPage) {
      showMore();
    }
  }, [status, inView, showMore, isLastPage]);

  if (hits.length === 0) {
    const NotFound = (
      <Box>
        <Center>
          <Stack spacing="md" align="center" maw={800}>
            {hiddenItems > 0 && (
              <Text color="dimmed">
                {hiddenItems} images have been hidden due to your settings.
              </Text>
            )}
            <ThemeIcon size={128} radius={100} sx={{ opacity: 0.5 }}>
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Title order={1} inline>
              No images found
            </Title>
            <Text align="center">
              We have a bunch of images, but it looks like we couldn&rsquo;t find any images with
              prompt or tags matching your query.
            </Text>
          </Stack>
        </Center>
      </Box>
    );

    const loading = status === 'loading' || status === 'stalled';

    if (loading) {
      return (
        <Box>
          <Center mt="md">
            <Loader />
          </Center>
        </Box>
      );
    }

    return (
      <Box>
        <Center mt="md">
          {/* Just enough time to avoid blank random page */}
          <TimeoutLoader renderTimeout={() => <>{NotFound}</>} delay={150} />
        </Center>
      </Box>
    );
  }

  if (loadingPreferences) {
    return (
      <Box>
        <Center mt="md">
          <Loader />
        </Center>
      </Box>
    );
  }

  return (
    <Stack>
      {hiddenItems > 0 && (
        <Text color="dimmed">{hiddenItems} images have been hidden due to your settings.</Text>
      )}
      <div
        className={classes.grid}
        style={{
          // Overwrite default sizing here.
          gridTemplateColumns: `repeat(auto-fill, minmax(290px, 1fr))`,
        }}
      >
        {images.map((hit) => (
          <Box
            key={hit.id}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSetImage(hit.id);
              // router.push(`/images/${hit.id}`);
            }}
          >
            <UnroutedImageCard data={hit} />
          </Box>
        ))}
      </div>
      {hits.length > 0 && (
        <Center ref={ref} sx={{ height: 36 }} mt="md">
          {!isLastPage && <Loader />}
        </Center>
      )}
    </Stack>
  );
}

type ImageViewerState = {
  imageId: number | null;
  images: { id: number }[];
  setImages: (images: { id: number }[]) => void;
  nextImageId: number | null;
  prevImageId: number | null;
  onClose: () => void;
  onSetImage: (imageId: number) => void;
};

const ImageViewerCtx = createContext<ImageViewerState>({} as any);
export const useImageViewerCtx = ({ images }: { images: { id: number }[] }) => {
  const context = useContext(ImageViewerCtx);
  if (!context) throw new Error('useImageViewerCtx can only be used inside ImageViewerCtx');

  useEffect(() => {
    context.setImages(images);
  }, [images]);

  return context;
};

const imageViewerQueryParams = z
  .object({
    imageId: z.coerce.number(),
  })
  .partial();
const ImageViewer = ({ children }: { children: React.ReactElement }) => {
  const router = useRouter();

  const [activeImageId, setActiveImageId] = useState<number | null>(null);
  const [images, setImages] = useState<{ id: number }[]>([]);

  const nextImageId = useMemo(() => {
    if (!activeImageId) return null;

    const index = images.findIndex((image) => image.id === activeImageId);
    if (index === -1) return null;
    return images[index + 1]?.id ?? null;
  }, [images, activeImageId]);

  const prevImageId = useMemo(() => {
    if (!activeImageId) return null;

    const index = images.findIndex((image) => image.id === activeImageId);
    if (index === -1) return null;
    return images[index - 1]?.id ?? null;
  }, [images, activeImageId]);

  const onSetImage = (imageId: number | null) => {
    if (!imageId) {
      return;
    }

    if (activeImageId) {
      router.replace(
        {
          pathname: router.pathname,
          query: {
            ...router.query,
            imageId: imageId ? imageId.toString() : undefined,
          },
        },
        undefined,
        { shallow: true }
      );
    } else {
      router.push(
        {
          pathname: router.pathname,
          query: {
            ...router.query,
            imageId: imageId ? imageId.toString() : undefined,
          },
        },
        undefined,
        { shallow: true }
      );
    }
  };
  const onClose = () => {
    router.replace(
      {
        pathname: router.pathname,
        query: {
          ...router.query,
          imageId: undefined,
        },
      },
      undefined,
      { shallow: true }
    );
  };

  useHotkeys([['Escape', onClose]]);

  useEffect(() => {
    if (router) {
      const res = imageViewerQueryParams.safeParse(router.query);
      console.log(res);
      if (!res.success || !res.data?.imageId) {
        setActiveImageId(null);
      } else {
        setActiveImageId(res.data.imageId ?? null);
      }
    }
  }, [router?.query]);

  useEffect(() => {
    if (router) {
      router.beforePopState((state) => {
        state.options.scroll = false;
        return true;
      });
    }
  }, [router]);

  console.log(router?.query);

  return (
    <ImageViewerCtx.Provider
      value={{
        imageId: activeImageId,
        nextImageId,
        prevImageId,
        images,
        setImages,
        onSetImage,
        onClose,
      }}
    >
      {activeImageId && (
        <div
          style={{
            position: 'fixed',
            zIndex: 99999,
          }}
        >
          <ImageDetailByProps
            imageId={activeImageId}
            onClose={onClose}
            nextImageId={nextImageId}
            prevImageId={prevImageId}
            onSetImage={onSetImage}
          />
        </div>
      )}
      {children}
    </ImageViewerCtx.Provider>
  );
};

ImageSearch.getLayout = function getLayout(page: React.ReactNode) {
  return (
    <ImageViewer>
      <SearchLayout indexName={IMAGES_SEARCH_INDEX}>{page}</SearchLayout>
    </ImageViewer>
  );
};

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.imageSearch) return { notFound: true };
  },
});
