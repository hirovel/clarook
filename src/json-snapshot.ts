// 日志与执行准备共用同一 JSON 值域和不可变快照,不让对象别名改写已确认的值。
export function freezeJson<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

export function jsonSnapshot<T>(input: T): { json: string; value: T } {
  const json = JSON.stringify(input);
  return { json, value: freezeJson(JSON.parse(json) as T) };
}
