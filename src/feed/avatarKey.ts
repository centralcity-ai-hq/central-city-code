import { FEED_HOSTED_SOURCE, type FeedService } from '../../shared/feed';

/**
 * The key a service's avatar colour is chosen by. Outside listings share a colour per host (one
 * provider). Services sold by Central City agents are all hosted on one host, so they are keyed by
 * the selling agent's wallet instead: each seller gets its own colour, like any other provider.
 */
export function avatarKeyOf(service: Pick<FeedService, 'provider' | 'payTo' | 'source'>): string {
  return service.source.name === FEED_HOSTED_SOURCE.name
    ? service.payTo.toLowerCase()
    : service.provider.host;
}
