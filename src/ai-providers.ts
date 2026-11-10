import manifest from '../package.json';

/** 提供者签名来自可编辑配置；邮箱仅为名称，其他签名使用字面文本。 */
export interface AiProvider {
  provider: string;
  nameTokens?: string[];
  emails?: string[];
  bracketTags?: string[];
  messageMarkers?: string[];
  subjectPrefixes?: string[];
}

export const AI_RULE_VERSION = 'ai-v8:community-providers:strict-provider-settings:github-noreply-alias:bare-trailer-identity:bounded-names:separated-trailer-body';

// 既有签名的来源许可见 licenses/provider-signatures.txt；识别口径由本插件独立定义。
// 社区扩充的产品来源及公开 Git 模式见 PROVIDERS.md；名称规则不意味着产品默认写入 trailer。
export const DEFAULT_AI_PROVIDERS: readonly AiProvider[] = manifest.contributes.configuration.properties['codeEvolutionLens.aiProviders'].default;
