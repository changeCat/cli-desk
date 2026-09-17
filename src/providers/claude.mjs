import {query} from '@anthropic-ai/claude-agent-sdk';
import {Engine} from './claude-engine.mjs';
import {resolveCli,verifyCli} from '../platform/cli-runtime.mjs';
import {fakeQuery} from '../mock.mjs';

// Provider boundary: the desktop layer does not depend on the Claude SDK protocol.
export function createClaudeProvider({smoke=false}={}) {
  return {
    id:'claude', label:'Claude',
    async check(configured) {
      if(smoke)return {path:'test-fixture',version:'测试模式 · 不连接模型'};
      const file=resolveCli(configured);return {path:file,version:await verifyCli(file)};
    },
    createEngine(store,emit) {return new Engine(store,smoke?fakeQuery:query,emit,smoke?()=> 'test-fixture':resolveCli);}
  };
}
