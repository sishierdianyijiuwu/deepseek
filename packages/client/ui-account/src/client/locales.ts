/** `account` namespace dictionaries (register / sign-in / sign-out copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title.register': '注册',
  'title.signIn': '登录',
  'title.checkEmail': '查收邮件',
  'email': '邮箱',
  'password': '密码',
  'submit.register': '注册',
  'submit.signIn': '登录',
  'submit.resend': '重发验证邮件',
  'switch.toSignIn': '已有账户？登录',
  'switch.toRegister': '没有账户？注册',
  'checkEmail.body': '我们已经向该邮箱发送了验证链接。验证完成后再登录。',
  'verified.ok': '邮箱已验证，现在可以登录。',
  'verified.invalid': '验证链接无效或已过期，请重新发送。',
  'signedIn.as': '已登录 {email}',
  'signOut': '退出登录',
  'busy': '处理中…',
  'error.network': '无法连接到服务器',
} satisfies Record<string, string>

/** The account namespace key union. */
export type AccountKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'title.register': 'Register',
  'title.signIn': 'Sign in',
  'title.checkEmail': 'Check your email',
  'email': 'Email',
  'password': 'Password',
  'submit.register': 'Register',
  'submit.signIn': 'Sign in',
  'submit.resend': 'Resend verification email',
  'switch.toSignIn': 'Already have an Account? Sign in',
  'switch.toRegister': 'Need an Account? Register',
  'checkEmail.body': 'We sent a verification link to this address. Sign in after the email is verified.',
  'verified.ok': 'Email verified. You can sign in now.',
  'verified.invalid': 'That verification link is invalid or expired. Request a new one.',
  'signedIn.as': 'Signed in as {email}',
  'signOut': 'Sign out',
  'busy': 'Working…',
  'error.network': 'Could not reach the server',
} satisfies Record<AccountKey, string>
