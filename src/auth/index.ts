import * as replitAuth from './replitAuth';
import * as fakeAuth from './fakeAuth';

const useFakeAuth =
  process.env.AUTH_MODE === 'fake' ||
  (process.env.AUTH_MODE !== 'replit' && process.env.NODE_ENV !== 'production');

export const setupAuth = useFakeAuth ? fakeAuth.setupAuth : replitAuth.setupAuth;
export const registerAuthRoutes = useFakeAuth ? fakeAuth.registerAuthRoutes : replitAuth.registerAuthRoutes;
export const isAuthenticated = useFakeAuth ? fakeAuth.isAuthenticated : replitAuth.isAuthenticated;
