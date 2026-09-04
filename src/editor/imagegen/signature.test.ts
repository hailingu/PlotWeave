/**
 * 生成输入签名（§13 输入签名：防旧结果覆盖新编辑）的契约：
 * 签名由生成输入（prompt/model/size）唯一决定；任一输入变化即视为
 * 「编辑已前进」，旧签名下的完成结果不得写入当前节点。
 */
import { describe, expect, it } from 'vitest'
import { imageGenSignature, signatureMatches } from './signature'

const base = { prompt: '雨夜霓虹街道，中景', model: 'openai:gpt-image-1', size: '1024x1536' }

describe('imageGenSignature（§13 输入签名）', () => {
  it('相同输入 → 相同签名', () => {
    expect(imageGenSignature(base)).toBe(imageGenSignature({ ...base }))
    expect(signatureMatches(base, { ...base })).toBe(true)
  })
  it('prompt / model / size 任一变化 → 签名失配', () => {
    expect(signatureMatches(base, { ...base, prompt: '换了描述' })).toBe(false)
    expect(signatureMatches(base, { ...base, model: 'openai:other' })).toBe(false)
    expect(signatureMatches(base, { ...base, size: '1536x1024' })).toBe(false)
  })
  it('prompt 以规范化值参与签名（首尾空白不制造假失配）', () => {
    expect(signatureMatches(base, { ...base, prompt: `  ${base.prompt}  ` })).toBe(true)
  })
})
