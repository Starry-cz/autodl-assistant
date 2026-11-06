import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AppError, fail } from './errors.mjs';
const secretPaths = [['aiSettings','apiKey'],['walletSettings','token'],['settings','webhookUrl'],['settings','webhookToken'],['settings','wechatToken']];
// 凭据只经标准输入传给系统保护 API，不放入命令行、环境变量或错误信息。标准输入只有 Base64，由 .NET 直接读取：
// 不经过 ConvertFrom-Json 等 cmdlet，开启 PowerShell 模块日志时日志里也不会出现凭据。操作名只取固定的两个值。
const dpapiScript = action => "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $out=[Security.Cryptography.ProtectedData]::"
  + (action === 'protect' ? 'Protect' : 'Unprotect') + "($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($out))";
export function systemSecretProtector({ platform = process.platform, run = execFileSync } = {}) {
  const available = platform === 'win32';
  function transform(action, value) {
    if (!available) fail('CREDENTIALS_UNAVAILABLE','此系统尚未提供安全凭据存储，请取消记住凭据，仅在本次服务中使用');
    try {
      const executable = path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      const result = run(executable,['-NoProfile','-NonInteractive','-Command',dpapiScript(action)],{
        input:Buffer.from(value).toString('base64'), encoding:'utf8',
        windowsHide:true, timeout:15000, maxBuffer:1024*1024, stdio:['pipe','pipe','pipe'],
      }).trim();
      if (!result || !/^[A-Za-z0-9+/]+={0,2}$/.test(result)) throw Error('invalid protection result');
      return Buffer.from(result,'base64');
    } catch { throw new AppError('CREDENTIALS_LOCKED','无法使用当前 Windows 用户解锁或保存凭据；不会回退为明文。请使用原用户和电脑，或清除凭据后重新配置'); }
  }
  return { available, method:available?'Windows DPAPI · 当前用户':'仅本次服务内存',
    protect:plain=>({version:1,method:'windows-dpapi-current-user',data:transform('protect',Buffer.from(plain,'utf8')).toString('base64')}),
    unprotect:sealed=>{
      if (sealed?.version!==1 || sealed.method!=='windows-dpapi-current-user' || typeof sealed.data!=='string' || sealed.data.length>1000000)
        fail('CREDENTIALS_LOCKED','已保存凭据格式无效，请保留任务文件并重新配置凭据');
      return transform('unprotect',Buffer.from(sealed.data,'base64')).toString('utf8');
    } };
}
export class SecretStorage {
  constructor(protector = systemSecretProtector()) { this.protector=protector; this.cachedPlain=''; this.cachedSealed=null; }
  publicState() { return {available:this.protector.available,method:this.protector.method}; }
  restore(data) {
    const sealed=data.protectedSecrets;
    if (sealed) {
      let secrets; try { secrets=JSON.parse(this.protector.unprotect(sealed)); } catch(error) {
        if(error instanceof AppError)throw error;
        fail('CREDENTIALS_LOCKED','已保存凭据无法解锁，请使用原 Windows 用户或清除凭据后重新配置');
      }
      if (!secrets || typeof secrets!=='object' || Array.isArray(secrets)) fail('CREDENTIALS_LOCKED','已保存凭据格式无效');
      for(const [section,key] of secretPaths) {
        const value=secrets[section+'.'+key];
        if(value!==undefined) {
          if(typeof value!=='string' || value.length>8192)fail('CREDENTIALS_LOCKED','已保存凭据字段无效');
          data[section]||={}; data[section][key]=value;
        }
      }
      delete data.protectedSecrets;
      this.cachedPlain=JSON.stringify(this.extract(data)); this.cachedSealed=sealed;
    }
    return !sealed && secretPaths.some(([section,key])=>typeof data[section]?.[key]==='string' && data[section][key]);
  }
  extract(data) {
    const secrets={};
    for(const [section,key] of secretPaths) {
      const value=data[section]?.[key];
      const remember=section==='aiSettings'?data.aiSettings?.rememberKey===true:section==='walletSettings'?data.walletSettings?.rememberToken===true:data.settings?.rememberCredentials!==false;
      if(remember && typeof value==='string' && value)secrets[section+'.'+key]=value;
    }
    return secrets;
  }
  serialize(data) {
    const copy=structuredClone(data), plain=JSON.stringify(this.extract(data));
    for(const [section,key] of secretPaths)if(copy[section])delete copy[section][key];
    if(copy.settings?.rememberCredentials===false){copy.settings.webhookEnabled=false;copy.settings.wechatEnabled=false;}
    if(plain!=='{}') {
      if(plain!==this.cachedPlain || !this.cachedSealed) { this.cachedSealed=this.protector.protect(plain); this.cachedPlain=plain; }
      copy.protectedSecrets=this.cachedSealed;
    } else { this.cachedPlain=''; this.cachedSealed=null; delete copy.protectedSecrets; }
    return copy;
  }
}

