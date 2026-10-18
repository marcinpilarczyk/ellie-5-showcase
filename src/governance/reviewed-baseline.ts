import type { EffectClass } from '../types/tool.js';

/**
 * Ellie Gateway (MCP) tools reviewed in this repo. Only these are exposed; nothing is discovered
 * at runtime (P3: unknown means not available). The fingerprint pins the reviewed definition.
 */
export interface BaselineReview {
  source: 'mcp';
  key: string;
  fingerprint: string;
  effectClass: EffectClass;
  interactivePermitted: boolean;
  backgroundPermitted: boolean;
  approvalRequired: boolean;
  metered: boolean;
  risk: string;
  notes: string;
}

const gatewayRead = (tool: string, fingerprint: string, notes: string): BaselineReview => ({
  source: 'mcp',
  key: `mcp_elliegateway_${tool}`,
  fingerprint,
  effectClass: 'READ',
  interactivePermitted: true,
  backgroundPermitted: true,
  approvalRequired: false,
  metered: false,
  risk: 'low',
  notes
});

export const REVIEWED_BASELINE: readonly BaselineReview[] = [
  gatewayRead('get_gateway_status', '71920a43db9747c71aa80e5f63a14e43881c8f16093899a04525d8f68db1f7a0', 'Gateway health only.'),
  gatewayRead('list_integrations', '84555525eee783e3ba4c7b0172a7eda70fd1be7b25ac2ac3f9b36501eae05cca', 'Gateway integration health only.'),
  gatewayRead('amazon_ads_list_profiles', '1883c295ff7610f4971294e1a84513e3f2c59bc660e8f708c89f9d02c927d794', 'Amazon Ads read: profiles.'),
  gatewayRead('amazon_ads_list_campaigns', '0569111fe2c8b685253b624ff868c51e4ead69ded78dfee6a2db291a205c3be1', 'Amazon Ads read: campaigns.'),
  gatewayRead('amazon_ads_get_campaign_performance', '3170710377f7e4244062a03aacf2fb5592252a42841fbe3a387372ac3a134b7d', 'Amazon Ads read: campaign metrics.'),
  gatewayRead('amazon_ads_get_target_performance', '4bd9ff7ef7d1b5f9ea051b2c416c4381f7c530f62c8301fec1d200cd2bf0f32d', 'Amazon Ads read: target metrics.'),
  gatewayRead('amazon_ads_get_search_terms', '4595ef30fda22308be5c5d57f08b725226a9eb084c311511ab3456190b75ed5e', 'Amazon Ads read: search terms.'),
  gatewayRead('meta_ads_get_account', '50e90c4802c3ba34e22d7a661e0ee0e9cb710e74108704b5c32c8fb5ae0b8ea0', 'Meta Ads read: account.'),
  gatewayRead('meta_ads_list_campaigns', '81035b33a4e771368a0c6aa9f19b009ca5d0d0e670bc02a63ebeec2cdad25b9d', 'Meta Ads read: campaigns.'),
  gatewayRead('meta_ads_get_campaign_performance', '2e946aeedc7d75f67dbcddf833c22235d31f68115f3c467bebba8920138771d0', 'Meta Ads read: campaign metrics.'),
  gatewayRead('meta_ads_get_adset_performance', '8295874eaa3b36a6f56c72ef3492d000bb2515be96991488f84b1694c3722ea2', 'Meta Ads read: ad set metrics.'),
  gatewayRead('meta_ads_get_ad_performance', 'bb4c6f433b8571fa76444cc016d65fd4a69dde3bcd043c1a2013d7f11a401434', 'Meta Ads read: ad metrics.'),
  gatewayRead('linkedin_get_profile', '5f61325062f65244c201f809eae3c4b1f4f5f054310d0f438b2bdae1afa599ba', 'LinkedIn DMA read: own profile.'),
  gatewayRead('linkedin_get_connections', '36973dfeae944b697825513a93e13b0d274664f9b9727b4500f8346235cca0a8', 'LinkedIn DMA read: connections.'),
  gatewayRead('linkedin_get_posts', 'ac457760a089cbb2da34dce4ebbbedeadceada126855f43211630d99cb789cce', 'LinkedIn DMA read: own posts.'),
  gatewayRead('linkedin_get_messages', '1fcc4d156303784b41e9a5bdc28505d851f0a630e4d242d403d5cd5cda770bcc', 'LinkedIn DMA read: message history.'),
  gatewayRead('linkedin_get_changelog', '1e0e83dc1f4c1652c8c64d9467c5e937d012768d18fb424e14bc03aa1e7fed24', 'LinkedIn DMA read: last 28 days of own activity.')
];
