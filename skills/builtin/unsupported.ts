/** unsupported: hand the remaining step to the user */
import { tr } from '../../src/i18n.ts';
import type { ToolSpec } from '../../src/types.ts';
import { obj, str } from '../../src/tool-helpers.ts';

export const unsupportedTool: ToolSpec = {
  name: 'unsupported',
  description: '把剩下需要用户亲手做的一步交给用户（扫码登录、挑选商品、付款、确认订单等），或 v1 完全做不了时调用。可以和 open_app / open_url 在同一轮一起调用：先把能做的做了，再用它说明剩下哪一步要用户做。不要编造网址或结果',
  parameters: obj({
    user_step: { type: 'string', description: '剩下要用户做的具体一步，祈使句，如「请扫码登录」；完全做不了就写用户可以怎么自己做' },
    reason: { type: 'string', description: '一句话说明为什么这一步要用户来做' },
  }, ['user_step', 'reason']),
  readOnly: true,
  cachePolicy: 'never',
  async exec(a) {
    return { ok: true, unsupported: true, display: tr(`需要你：${str(a.user_step) || str(a.reason)}`, `Your turn: ${str(a.user_step) || str(a.reason)}`) };
  },
};
