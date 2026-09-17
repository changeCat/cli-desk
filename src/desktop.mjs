import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
const callbacks = new Set();
const ready = listen('desk:event', event => { for (const callback of callbacks) callback(event.payload); });
const methods = ['state','get','create','rename','model','delete','archives','restore','purge','draft','send','stop','answer','folder','cli','settings','check','copy','export','data','openCwd','link'];
export const desk = Object.fromEntries(methods.map(method => [method, async payload => {
  await ready;
  try { return await invoke('desk_request', {method,payload:payload ?? null}); }
  catch (error) { throw new Error(typeof error === 'string' ? error : error.message); }
}]));
desk.onEvent = callback => { callbacks.add(callback); return () => callbacks.delete(callback); };
if (import.meta.env.DEV) window.__desktopTest = (action,response) => invoke('test_desktop',{action,response});
