/**
 * EmbeddingProvider 端口
 *
 * 文本 → 向量嵌入，供经验/技能语义检索与去重使用。MVP 尚未实现适配器。
 */
export interface EmbeddingProvider {
  /** 嵌入向量的维度 */
  readonly dimensions: number;

  /** 将文本编码为向量 */
  embed(text: string): Promise<number[]>;

  /** 计算两个向量的余弦相似度 */
  cosineSimilarity(a: number[], b: number[]): number;
}
