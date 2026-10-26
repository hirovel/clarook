// 启动与模型配置的宿主契约;不依赖终端组件或应用组装。
import type { ModelConfig, Preset } from "../src/config.js";
import type { Price } from "../src/cost.js";
import type { EffortLevel, Provider } from "../src/provider.js";
import type { SettingLayers } from "../src/settings.js";
import type { CapabilitySource, Inferred } from "./registry.js";

export type ModelChoice = {
  provider: Provider;
  model: string;
  providerName: string;
  contextWindow: number;
  /** 该模型声明支持的强度级别;不声明 = 不校验。 */
  effortLevels?: EffortLevel[];
  /** 价格数据(配置里给了才有),只用于显示费用。 */
  price?: Price;
  /** 窗口数据的出处:config / models.dev / assumed。 */
  capabilitySource?: CapabilitySource;
  /** 拿不到 provider 的原因(缺 key);界面据此打开登录对话框,发消息时提示。 */
  unavailable?: string;
};

export type ModelSettings = {
  /** "供应商/模型" 列表,供 /model 与补全使用。 */
  listModels(): string[];
  /** 顶层配置的默认模型;defaults.model 是可移除的覆盖。 */
  defaultModel?(): string;
  /** 某模型的价格;没配置返回 undefined。会话里换过模型时按各自价格累计。 */
  priceFor?(model: string): Price | undefined;
  /** 按名切换模型(可能需要读 key),返回新 provider。 */
  switchModel(name: string): ModelChoice;
  /** 写入某供应商的 key 并落盘。 */
  setKey(providerName: string, key: string): void;
  /** 把某模型设为缺省并落盘。 */
  setDefault(model: string): void;
  /** 供应商清单(名、协议、key 来源、环境变量名、配置里的模型),登录对话框用。 */
  providers?(): ProviderSummary[];
  /** 用一把 key 向供应商查模型清单;失败可能来自凭据、接口或网络。登录验证可取消。 */
  verifyKey?(providerName: string, key: string, signal?: AbortSignal): Promise<string[]>;
  /** 给配置里没有的模型推出配置(models.dev → 抄最像的 → 假设),带出处;选择器用来写行注与落盘。 */
  describeModel?(providerName: string, modelId: string): Promise<Inferred>;
  /** 把一个模型写进配置并落盘。 */
  addModel?(providerName: string, model: ModelConfig): void;
  /** 已配置模型生效的能力数据一行注(窗口、价格、出处;配置覆盖了登记簿时带登记簿的值)。 */
  capabilityNote?(providerName: string, modelId: string): Promise<string>;
  /** 配置的 defaults 与当前预设:/settings 据此写来源列。 */
  settingLayers?(): SettingLayers;
  /** 写一个开关进配置 defaults 并落盘;undefined 删掉那一项。 */
  saveSetting?(key: string, value: unknown): void;
  /** 一次保存组合中的多个设置，避免部分写入。 */
  saveSettings?(values: Partial<Preset>): void;
  /** 只包含方案,不暴露供应商连接或凭据。 */
  listPresets?(): { name: string; values: Preset }[];
  savePreset?(name: string, values: Preset): void;
  /** 把方案写为后续启动的 defaults,不伪装成当前会话已切换。 */
  usePreset?(name: string): void;
};

export type ProviderSummary = {
  name: string;
  protocol: string;
  /** 存放 key 的环境变量名(配置里给了才有)。 */
  env?: string;
  /** key 现在从哪来;没有就是缺。 */
  keySource?: "env" | "credentials" | "config";
  /** 配置里列出的模型名。 */
  models: string[];
};
