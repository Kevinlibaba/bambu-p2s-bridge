/**
 * 「某个路径上的文件变了」的统一广播。
 *
 * 桥接里有四层按路径缓存的东西：files.ts 的中央目录、预览图；print.ts 的
 * 3mf 解析结果；slice.ts 的作者参数。它们各自封闭在自己的模块或闭包里，
 * 写入方（上传、导入、删除、切片落盘）够不着别人的缓存 —— 结果是切片产物
 * 落盘后只清了预览图，60 秒内重开新产物会按旧的偏移去读，报「本地文件头无效」；
 * 同名重传后调参会拿 10 分钟前的作者设置当基准，把作者的支撑当成用户改动关掉。
 *
 * 所以：谁缓存谁注册，谁写文件谁广播。没有别的路径可以绕开这里。
 */
type Hook = (path: string) => void

const hooks: Hook[] = []

export function onFileChange(hook: Hook): void {
  hooks.push(hook)
}

/** 路径必须是 normalizePath 之后的形式，各缓存都是按它做键的 */
export function fileChanged(path: string): void {
  for (const h of hooks) h(path)
}
