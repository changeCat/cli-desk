export const permissionModes = {
  default: {label:'请求批准',icon:'✋',description:'需要授权的工具操作由你确认'},
  auto: {label:'帮我批准',icon:'◇',description:'由 Claude 自动评估，必要时仍请求确认'},
  bypassPermissions: {label:'完全访问权限',icon:'⚠',description:'跳过常规工具审批，仍受系统和既有规则限制'}
};
export function validatePermissionMode(mode) {
  if (typeof mode !== 'string' || !Object.hasOwn(permissionModes,mode)) throw new Error('无效的审批模式');
  return mode;
}
export function permissionLabel(mode) {
  return permissionModes[mode]?.label || {acceptEdits:'自动接受编辑',plan:'规划模式',dontAsk:'仅允许预授权操作'}[mode] || '未知模式';
}
