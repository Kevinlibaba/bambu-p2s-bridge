/**
 * config.ts 在模块加载时就要求打印机凭据（生产环境要的就是这个快速失败）。
 * 测试跑的是脱机逻辑，这里先填上占位值。
 * 通过 `node --import` 预载，保证在任何被测模块之前生效。
 */
process.env.BAMBU_HOST ??= '127.0.0.1'
process.env.BAMBU_SERIAL ??= 'TEST-SERIAL'
process.env.BAMBU_ACCESS_CODE ??= 'placeholder'
process.env.API_TOKEN ??= 'placeholder-token-for-tests'
