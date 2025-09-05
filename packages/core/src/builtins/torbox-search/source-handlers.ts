import { number, z } from 'zod';
import { Stream } from '../../db';
import {
  Cache,
  Env,
  SERVICE_DETAILS,
  createLogger,
  getTimeTakenSincePoint,
} from '../../utils';
import { DebridService, DebridFile } from './debrid-service';
import { ParsedId } from '../utils/id-parser';
import { TorBoxSearchAddonUserDataSchema } from './schemas';
import TorboxSearchApi, {
  TorboxApiError,
  TorboxSearchApiIdType,
} from './search-api';
import { Torrent, convertDataToTorrents } from './torrent';
import { TMDBMetadata } from '../../metadata/tmdb';
import { calculateAbsoluteEpisode } from '../utils/general';
import { TorboxApi } from '@torbox/torbox-api';

const logger = createLogger('torbox-search');

export interface TitleMetadata {
  titles: string[];
  seasons?: {
    number: string;
    episodes: number;
  }[];
}

abstract class SourceHandler {
  protected searchCache = Cache.getInstance<string, Torrent[]>(
    'torbox-search-torrents'
  );
  protected metadataCache = Cache.getInstance<string, TitleMetadata>(
    'torbox-search-metadata'
  );
  protected instantAvailabilityCache = Cache.getInstance<string, boolean>(
    'tb-search-usenet-instant'
  );

  protected errorStreams: Stream[] = [];
  protected readonly useCache: boolean;

  constructor(
    protected searchApi: TorboxSearchApi,
    protected readonly searchUserEngines: boolean
  ) {
    this.useCache =
      !this.searchUserEngines ||
      Env.BUILTIN_TORBOX_SEARCH_CACHE_PER_USER_SEARCH_ENGINE;
  }

  abstract getStreams(
    parsedId: ParsedId,
    userData: z.infer<typeof TorBoxSearchAddonUserDataSchema>
  ): Promise<Stream[]>;

  protected getCacheKey(
    parsedId: ParsedId,
    type: 'torrent' | 'usenet'
  ): string {
    let cacheKey = `${type}:${parsedId.type}:${parsedId.id}:${parsedId.season}:${parsedId.episode}`;
    if (this.searchUserEngines) {
      cacheKey += `:${this.searchApi.apiKey}`;
    }
    return cacheKey;
  }

  protected createStream(
    id: ParsedId,
    torrent: Torrent,
    file: DebridFile,
    userData: z.infer<typeof TorBoxSearchAddonUserDataSchema>,
    season?: string,
    episode?: string,
    absoluteEpisode?: string
  ): Stream & { type: 'torrent' | 'usenet' } {
    const storeAuth = {
      storeName: file.service.id,
      storeCredential: userData.services.find(
        (service) => service.id === file.service.id
      )?.credential,
    };

    const playbackInfo =
      torrent.type === 'torrent'
        ? {
            parsedId: {
              id: id.id,
              type: id.type,
              season: season || undefined,
              episode: episode || undefined,
              absoluteEpisode: absoluteEpisode || undefined,
            },
            type: 'torrent',
            hash: torrent.hash,
            index: file.index,
            title: torrent.title,
          }
        : {
            type: 'usenet',
            nzb: torrent.nzb,
            title: torrent.title,
          };

    const svcMeta = SERVICE_DETAILS[file.service.id];
    const name = `[${svcMeta.shortName} ${file.service.cached ? '⚡' : '⏳'}${file.service.owned ? ' ☁️' : ''}] TorBox Search`;
    const description = `${torrent.title}\n${file.filename}\n${torrent.indexer ? `🔍 ${torrent.indexer}` : ''} ${torrent.seeders ? `👤 ${torrent.seeders}` : ''} ${torrent.age && torrent.age !== '0d' ? `🕒 ${torrent.age}` : ''}`;

    return {
      url: `${Env.BASE_URL}/api/v1/debrid/resolve/${encodeURIComponent(Buffer.from(JSON.stringify(storeAuth)).toString('base64'))}/${encodeURIComponent(Buffer.from(JSON.stringify(playbackInfo)).toString('base64'))}/${encodeURIComponent(file.filename || torrent.title)}`,
      name,
      description,
      type: torrent.type,
      infoHash: torrent.hash,
      behaviorHints: {
        videoSize: file.size,
        filename: file.filename,
      },
    };
  }

  protected createErrorStream(error: {
    title: string;
    description: string;
  }): Stream {
    return {
      name: `[❌] TorBox Search ${error.title}`,
      description: error.description,
      externalUrl: 'stremio:///',
    };
  }
}

export class TorrentSourceHandler extends SourceHandler {
  private readonly debridServices: DebridService[];

  constructor(
    searchApi: TorboxSearchApi,
    services: z.infer<typeof TorBoxSearchAddonUserDataSchema>['services'],
    searchUserEngines: boolean,
    clientIp?: string
  ) {
    super(searchApi, searchUserEngines);
    this.debridServices = services.map(
      (service) => new DebridService(service, clientIp)
    );
  }

  async getStreams(
    parsedId: ParsedId,
    userData: z.infer<typeof TorBoxSearchAddonUserDataSchema>
  ): Promise<Stream[]> {
    const { type, id, season, episode } = parsedId;
    let torrents: Torrent[] = [];
    try {
      torrents = await this.fetchTorrents(
        type,
        id,
        season,
        episode,
        userData.tmdbAccessToken
      );
    } catch (error) {
      if (error instanceof TorboxApiError) {
        switch (error.errorCode) {
          case 'BAD_TOKEN':
            return [
              this.createErrorStream({
                title: ``,
                description: 'Invalid/expired credentials',
              }),
            ];
          default:
            logger.error(`Error fetching torrents for ${type}:${id}: ${error}`);
            throw error;
        }
      }
      logger.error(
        `Unexpected error fetching torrents for ${type}:${id}: ${error}`
      );
      throw error;
    }

    if (torrents.length === 0) return [];

    if (userData.onlyShowUserSearchResults) {
      const userSearchResults = torrents.filter(
        (torrent) => torrent.userSearch
      );
      logger.info(
        `Filtered out ${torrents.length - userSearchResults.length} torrents that were not user search results`
      );
      if (userSearchResults.length > 0) {
        torrents = userSearchResults;
      } else {
        return [];
      }
    }

    const titleMetadata = await this.metadataCache.get(
      `metadata:${type}:${id}`
    );
    const filesByHash = await this.getAvailableFilesFromDebrid(
      torrents,
      parsedId,
      titleMetadata
    );
    const absoluteEpisode =
      season && episode && titleMetadata?.seasons
        ? calculateAbsoluteEpisode(season, episode, titleMetadata.seasons)
        : undefined;

    const streams: Stream[] = [];
    for (const torrent of torrents) {
      const availableFiles = filesByHash.get(torrent.hash);
      if (availableFiles) {
        for (const file of availableFiles) {
          streams.push(
            this.createStream(
              parsedId,
              torrent,
              file,
              userData,
              season,
              episode,
              absoluteEpisode
            )
          );
        }
      }
    }

    streams.push(...this.errorStreams);

    return streams;
  }

  private async fetchTorrents(
    idType: TorboxSearchApiIdType,
    id: string,
    season?: string,
    episode?: string,
    tmdbAccessToken?: string
  ): Promise<Torrent[]> {
    const cacheKey = this.getCacheKey(
      { type: idType, id, season, episode },
      'torrent'
    );

    const cachedTorrents = await this.searchCache.get(cacheKey);

    if (
      cachedTorrents &&
      (!this.searchUserEngines ||
        Env.BUILTIN_TORBOX_SEARCH_CACHE_PER_USER_SEARCH_ENGINE)
    ) {
      logger.info(`Found ${cachedTorrents.length} (cached) torrents for ${id}`);
      return cachedTorrents;
    }

    const start = Date.now();
    const data = await this.searchApi.getTorrentsById(idType, id, {
      search_user_engines: this.searchUserEngines ? 'true' : 'false',
      season,
      episode,
      metadata: 'true',
      check_owned: 'true',
    });

    const torrents = convertDataToTorrents(data.torrents);
    logger.info(
      `Found ${torrents.length} torrents for ${id} in ${getTimeTakenSincePoint(start)}`
    );

    if (data.metadata) {
      const { tmdb_id, titles } = data.metadata;
      let seasons;

      if (
        ['kitsu_id', 'mal_id', 'anilist_id', 'anidb_id'].includes(idType) &&
        tmdb_id
      ) {
        const seasonFetchStart = Date.now();
        try {
          const tmdbMetadata = await new TMDBMetadata({
            accessToken: tmdbAccessToken,
          }).getMetadata(`tmdb:${tmdb_id}`, 'series');
          seasons = tmdbMetadata?.seasons?.map(
            ({ season_number, episode_count }) => ({
              number: season_number.toString(),
              episodes: episode_count,
            })
          );
          logger.debug(
            `Fetched additional season info for ${id} in ${getTimeTakenSincePoint(seasonFetchStart)}`
          );
        } catch (error) {
          logger.error(
            `Failed to fetch TMDB metadata for ${idType}:${id} - ${error}`
          );
        }
      }

      this.metadataCache.set(
        `metadata:${idType}:${id}`,
        { titles: [...new Set(titles)], seasons },
        Env.BUILTIN_TORBOX_SEARCH_METADATA_CACHE_TTL
      );
    }

    if (torrents.length === 0) {
      return [];
    }

    if (this.useCache) {
      await this.searchCache.set(
        cacheKey,
        torrents.filter(
          (torrent) =>
            !torrent.userSearch ||
            (this.searchUserEngines &&
              Env.BUILTIN_TORBOX_SEARCH_CACHE_PER_USER_SEARCH_ENGINE)
        ),
        Env.BUILTIN_TORBOX_SEARCH_SEARCH_API_CACHE_TTL
      );
    }

    return torrents;
  }

  private async getAvailableFilesFromDebrid(
    torrents: Torrent[],
    parsedId: ParsedId,
    titleMetadata?: TitleMetadata
  ): Promise<Map<string, DebridFile[]>> {
    const allFiles = new Map<string, DebridFile[]>();
    const servicePromises = this.debridServices.map((service) =>
      service.getAvailableFiles(torrents, parsedId, titleMetadata)
    );

    const results = await Promise.allSettled(servicePromises);

    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value instanceof Array) {
          for (const file of result.value) {
            const existing = allFiles.get(file.hash) || [];
            allFiles.set(file.hash, [...existing, file]);
          }
        } else {
          this.errorStreams.push(
            this.createErrorStream({
              title: result.value.error.title,
              description: result.value.error.description,
            })
          );
        }
      }
    }
    return allFiles;
  }
}

export class UsenetSourceHandler extends SourceHandler {
  private readonly torboxApi: TorboxApi;
  private readonly clientIp?: string;

  constructor(
    searchApi: TorboxSearchApi,
    torboxApi: TorboxApi,
    searchUserEngines: boolean
  ) {
    super(searchApi, searchUserEngines);
    this.torboxApi = torboxApi;
  }

  async getStreams(
    parsedId: ParsedId,
    userData: z.infer<typeof TorBoxSearchAddonUserDataSchema>
  ): Promise<Stream[]> {
    const { type, id, season, episode } = parsedId;
    const cacheKey = this.getCacheKey(parsedId, 'usenet');
    let usingCachedSearch = false;

    let torrents = await this.searchCache.get(cacheKey);

    if (!torrents) {
      const start = Date.now();
      try {
        const data = await this.searchApi.getUsenetById(type, id, {
          season,
          episode,
          check_cache: 'true',
          check_owned: 'true',
          search_user_engines: this.searchUserEngines ? 'true' : 'false',
        });
        torrents = convertDataToTorrents(data.nzbs);
        logger.info(
          `Found ${torrents.length} NZBs for ${id} in ${getTimeTakenSincePoint(start)}`
        );
        if (torrents.length === 0) {
          return [];
        }
        if (this.useCache) {
          await this.searchCache.set(
            cacheKey,
            torrents,
            Env.BUILTIN_TORBOX_SEARCH_SEARCH_API_CACHE_TTL
          );
        }
      } catch (error) {
        if (error instanceof TorboxApiError) {
          switch (error.errorCode) {
            case 'BAD_TOKEN':
              return [
                this.createErrorStream({
                  title: ``,
                  description: 'Invalid/expired credentials',
                }),
              ];
            default:
              logger.error(`Error fetching NZBs for ${id}: ${error.message}`);
              throw error;
          }
        }
        logger.error(`Unexpected error fetching NZBs for ${id}: ${error}`);
        throw error;
      }
    } else {
      usingCachedSearch = true;
      logger.info(`Found ${torrents.length} (cached) NZBs for ${id}`);
    }

    if (userData.onlyShowUserSearchResults) {
      const userSearchResults = torrents.filter(
        (torrent) => torrent.userSearch
      );
      logger.info(
        `Filtered out ${torrents.length - userSearchResults.length} NZBs that were not user search results`
      );
      if (userSearchResults.length > 0) {
        torrents = userSearchResults;
      } else {
        return [];
      }
    }

    let instantAvailability: Map<string, boolean> | undefined;
    // when using a cached search, we need to check instant availability separately
    if (usingCachedSearch) {
      instantAvailability = await this.getInstantAvailability(torrents);
    }

    return torrents.map((torrent) => {
      const file: DebridFile = {
        hash: torrent.hash,
        filename: torrent.title,
        size: torrent.size,
        index: -1,
        service: {
          id: 'torbox',
          cached:
            instantAvailability?.get(torrent.hash) ?? torrent.cached ?? false,
          owned: torrent.owned ?? false,
        },
      };
      return this.createStream(
        parsedId,
        torrent,
        file,
        userData,
        season,
        episode
      );
    });
  }

  private async getInstantAvailability(
    torrents: Torrent[]
  ): Promise<Map<string, boolean> | undefined> {
    const start = Date.now();
    const instantAvailability = new Map<string, boolean>();

    const torrentsToCheck: Torrent[] = [];
    for (const torrent of torrents) {
      const cachedStatus = await this.instantAvailabilityCache.get(
        torrent.hash
      );
      if (cachedStatus !== undefined) {
        instantAvailability.set(torrent.hash, cachedStatus);
      } else {
        torrentsToCheck.push(torrent);
      }
    }
    if (torrentsToCheck.length > 0) {
      logger.debug(
        `Checking instant availability for ${torrentsToCheck.length} NZBs`
      );
      const data = await this.torboxApi.usenet.getUsenetCachedAvailability(
        'v1',
        {
          hash: torrentsToCheck.map((torrent) => torrent.hash).join(','),
          format: 'list',
        }
      );
      if (!data.data?.success) {
        throw new Error(
          `Failed to check instant availability: ${data.data?.detail} - ${data.data?.error}`
        );
      }
      if (!Array.isArray(data.data.data)) {
        throw new Error('Invalid response from Torbox API');
      }
      for (const torrent of torrentsToCheck) {
        const item = data.data.data.find((item) => item.hash === torrent.hash);
        instantAvailability.set(torrent.hash, Boolean(item));
        this.instantAvailabilityCache.set(
          torrent.hash,
          Boolean(item),
          Env.BUILTIN_TORBOX_SEARCH_INSTANT_AVAILABILITY_CACHE_TTL
        );
      }
    }
    const cachedTorrents = torrents.filter(
      (torrent) => instantAvailability.get(torrent.hash) ?? torrent.cached
    );
    logger.info(
      `Checked instant availability for ${torrents.length} NZBs in ${getTimeTakenSincePoint(start)}: ${cachedTorrents.length} / ${torrents.length} cached (with ${
        torrents.length - torrentsToCheck.length
      } cached statuses)`
    );
    return instantAvailability;
  }
}
