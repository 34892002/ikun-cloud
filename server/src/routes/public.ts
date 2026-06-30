/**
 * 公开路由 — /api/public/*
 * guest 可访问，无需登录
 */
import { Hono } from 'hono'
import { sign } from 'jsonwebtoken'
import { compareSync, hashSync } from 'bcryptjs'
import { generateChallenge, validateChallenge } from 'capjs-core'
import { db } from '@/db'
import { users, siteSettings, announcements, inviteCodes } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { success, error } from '@/utils/response'
import { JWT_SECRET } from '@/middleware/auth'
import type { JwtPayload, UserRole } from '@/middleware/auth'

const publicRoutes = new Hono()

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d'
const CAP_SECRET = process.env.CAP_SECRET || process.env.JWT_SECRET + '-cap'

// ============================================================
// POST /cap/challenge — 获取 Cap 验证挑战
// ============================================================
publicRoutes.post('/cap/challenge', async (c) => {
  try {
    const challenge = await generateChallenge(CAP_SECRET, {
      scope: 'login',
      instrumentation: true,
    })
    return c.json(challenge)
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : '生成挑战失败' }, 500)
  }
})

// ============================================================
// POST /cap/redeem — 兑换 Cap 挑战（widget 解完 PoW 后调用）
// ============================================================
publicRoutes.post('/cap/redeem', async (c) => {
  try {
    const body = await c.req.json()
    const result = await validateChallenge(CAP_SECRET, {
      token: body.token,
      solutions: body.solutions,
      instr: body.instr,
      instr_blocked: body.instr_blocked,
      instr_timeout: body.instr_timeout,
    }, {
      scope: 'login',
    })
    return c.json(result)
  } catch (err: unknown) {
    return c.json({ success: false, reason: err instanceof Error ? err.message : '验证失败' }, 400)
  }
})

// ============================================================
// POST /login — 登录
// ============================================================
publicRoutes.post('/login', async (c) => {
  const { username, password, capToken } = await c.req.json<{ username: string; password: string; capToken?: string }>()

  // Cap 验证（非强制，但推荐）
  if (!capToken) {
    return c.json(error('请完成人机验证'), 400)
  }

  if (!username || !password) {
    return c.json(error('用户名和密码不能为空'), 400)
  }

  const user = db.select().from(users).where(eq(users.username, username)).get()

  if (!user) {
    return c.json(error('用户名或密码错误'), 401)
  }

  const isValid = compareSync(password, user.passwordHash)

  if (!isValid) {
    return c.json(error('用户名或密码错误'), 401)
  }

  const payload: JwtPayload = { userId: user.id, username: user.username, role: user.role as UserRole }
  const token = sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })

  return c.json(success({
    token,
    user: { id: user.id, username: user.username, role: user.role },
  }))
})

// ============================================================
// POST /logout — 登出（前端清 token，后端无需处理）
// ============================================================
publicRoutes.post('/logout', (c) => {
  return c.json(success(null, '登出成功'))
})

// ============================================================
// POST /register — 用户注册
// ============================================================
publicRoutes.post('/register', async (c) => {
  const settings = db.select().from(siteSettings).all()
  const map = Object.fromEntries(settings.map((s) => [s.key, s.value]))
  const mode = map.register_mode || 'closed'

  if (mode === 'closed') {
    return c.json(error('暂未开放注册'), 403)
  }

  const { username, password, inviteCode } = await c.req.json<{ username: string; password: string; inviteCode?: string }>()

  if (!username || !password) {
    return c.json(error('用户名和密码不能为空'), 400)
  }

  if (username.length < 3 || username.length > 32) {
    return c.json(error('用户名长度 3-32 个字符'), 400)
  }

  if (password.length < 6) {
    return c.json(error('密码长度不能少于 6 位'), 400)
  }

  // 邀请码模式
  let usedInviteCode: string | null = null
  if (mode === 'invite') {
    if (!inviteCode) {
      return c.json(error('请填写邀请码'), 400)
    }
    const code = db.select().from(inviteCodes).where(eq(inviteCodes.code, inviteCode)).get()
    if (!code) {
      return c.json(error('邀请码无效'), 400)
    }
    if (code.usedAt) {
      return c.json(error('邀请码已被使用'), 400)
    }
    usedInviteCode = inviteCode
  }

  const existing = db.select().from(users).where(eq(users.username, username)).get()
  if (existing) {
    return c.json(error('用户名已存在'), 409)
  }

  const passwordHash = hashSync(password, 10)
  const newUser = db.insert(users).values({ username, passwordHash, role: 'user', inviteCode: usedInviteCode }).returning().get()

  // 标记邀请码已使用
  if (usedInviteCode) {
    db.update(inviteCodes).set({ usedBy: newUser.id, usedAt: new Date().toISOString() }).where(eq(inviteCodes.code, usedInviteCode)).run()
  }

  return c.json(success({ id: newUser.id, username: newUser.username, role: newUser.role }, '注册成功'))
})

// ============================================================
// GET /announcements — 公告列表（仅 active）
// ============================================================
publicRoutes.get('/announcements', (c) => {
  const items = db.select().from(announcements).all()
    .filter((a) => a.isActive === 1)
    .sort((a, b) => b.id - a.id)

  return c.json(success(items))
})

// ============================================================
// GET /site-info — 站点公开信息
// ============================================================
publicRoutes.get('/site-info', (c) => {
  const settings = db.select().from(siteSettings).all()
  const map = Object.fromEntries(settings.map((s) => [s.key, s.value]))

  return c.json(success({
    siteName: map.site_name || 'ikun-cloud',
    registrationOpen: map.registration_open === 'true',
    registerMode: map.register_mode || 'closed',
    hostIp: map.host_ip || '',
  }))
})

export default publicRoutes
