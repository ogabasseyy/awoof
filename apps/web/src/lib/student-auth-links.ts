import { resolveStudentReturn } from './student-return';

export type StudentAuthLinks = Readonly<{
  loginPath: string;
  registerPath: string;
}>;

export function createStudentAuthLinks(returnTo: string | null, origin: string | null): StudentAuthLinks {
  if (!origin || returnTo === null) {
    return { loginPath: '/auth/student/login', registerPath: '/auth/student/register' };
  }
  const query = new URLSearchParams({ redirect: resolveStudentReturn(returnTo, origin) }).toString();
  return {
    loginPath: `/auth/student/login?${query}`,
    registerPath: `/auth/student/register?${query}`,
  };
}
