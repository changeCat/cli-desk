import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
const callbacks = new Set();
const dispatch = value => { for (const callback of callbacks) callback(value); };
const ready = Promise.all([
  listen('desk:event', event => dispatch(event.payload)),
  getCurrentWebview().onDragDropEvent(event => dispatch({type:'fileDrag',data:event.payload}))
]);
const methods = ['state','get','create','rename','model','permission','delete','archives','restore','purge','draft','attach','send','stop','answer','folder','files','cli','settings','check','copy','export','data','openCwd','reveal','link','updateCheck'];
export const desk = Object.fromEntries(methods.map(method => [method, async payload => {
  await ready;
  try { return await invoke('desk_request', {method,payload:payload ?? null}); }
  catch (error) { throw new Error(typeof error === 'string' ? error : error.message); }
}]));
desk.onEvent = callback => { callbacks.add(callback); return () => callbacks.delete(callback); };
if (import.meta.env.DEV) window.__desktopTest = (action,response) => invoke('test_desktop',{action,response});
