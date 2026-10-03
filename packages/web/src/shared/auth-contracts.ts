import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

export interface AuthUser {
  id: string;
  companyId: string;
  email: string;
  name: string;
}

export interface AuthenticatedState {
  state: "authenticated";
  user: AuthUser;
  expiresAt: number;
  /** Returned once when password + TOTP is enrolled or replaced. */
  recoveryCodes?: string[];
}

export interface EnrollmentState {
  state: "enrollment";
  email: string;
  name: string;
  reason: "invitation" | "recovery";
}

export type AuthState =
  | AuthenticatedState
  | EnrollmentState
  | { state: "totp_required"; email: string }
  | { state: "signed_out" };

export interface AuthErrorBody {
  error: { code: string; message: string };
}

export interface SecurityState {
  passkeys: { id: string; name: string; createdAt: number }[];
  totpEnabled: boolean;
  passwordEnabled: boolean;
  recoveryCodesRemaining: number;
  sessions: {
    id: string;
    createdAt: number;
    expiresAt: number;
    current: boolean;
  }[];
  /** Changes require a sign-in completed within the last ten minutes. */
  canManage: boolean;
}

export interface TotpEnrollment {
  secret: string;
  uri: string;
}

/** All mutations use JSON and the same browser origin as the application. */
export interface AuthEndpoints {
  "/api/auth/session": { method: "GET"; response: AuthState };
  "/api/auth/password": {
    method: "POST";
    request: { email: string; password: string };
    response: AuthState;
  };
  "/api/auth/totp": {
    method: "POST";
    request: { code: string };
    response: AuthenticatedState;
  };
  "/api/auth/passkey/login/options": {
    method: "POST";
    request: Record<string, never>;
    response: { options: PublicKeyCredentialRequestOptionsJSON };
  };
  "/api/auth/passkey/login/verify": {
    method: "POST";
    request: { response: AuthenticationResponseJSON };
    response: AuthenticatedState;
  };
  "/api/auth/logout": {
    method: "POST";
    request: Record<string, never>;
    response: { state: "signed_out" };
  };
  "/api/auth/enrollment/start": {
    method: "POST";
    request: { token: string };
    response: EnrollmentState;
  };
  "/api/auth/enrollment/totp/start": {
    method: "POST";
    request: { name: string; password: string };
    response: TotpEnrollment;
  };
  "/api/auth/enrollment/totp/verify": {
    method: "POST";
    request: { code: string };
    response: AuthenticatedState;
  };
  "/api/auth/enrollment/passkey/options": {
    method: "POST";
    request: { name: string };
    response: { options: PublicKeyCredentialCreationOptionsJSON };
  };
  "/api/auth/enrollment/passkey/verify": {
    method: "POST";
    request: { response: RegistrationResponseJSON };
    response: AuthenticatedState;
  };
  "/api/auth/recovery/start": {
    method: "POST";
    request: { email: string; password: string; code: string };
    response: EnrollmentState;
  };
  "/api/auth/security": { method: "GET"; response: SecurityState };
  "/api/auth/security/passkey/options": {
    method: "POST";
    request: { name: string };
    response: { options: PublicKeyCredentialCreationOptionsJSON };
  };
  "/api/auth/security/passkey/verify": {
    method: "POST";
    request: { response: RegistrationResponseJSON; name?: string };
    response: SecurityState;
  };
  "/api/auth/security/passkey/remove": {
    method: "POST";
    request: { id: string };
    response: SecurityState;
  };
  "/api/auth/security/totp/start": {
    method: "POST";
    /** Sets the password for the new TOTP sign-in method. */
    request: { password: string };
    response: TotpEnrollment;
  };
  "/api/auth/security/totp/verify": {
    method: "POST";
    request: { code: string };
    response: AuthenticatedState;
  };
  "/api/auth/security/sessions/revoke": {
    method: "POST";
    request: { id: string };
    response: SecurityState | { state: "signed_out" };
  };
}

export const AUTH_ENDPOINTS = {
  session: "/api/auth/session",
  password: "/api/auth/password",
  totp: "/api/auth/totp",
  passkeyLoginOptions: "/api/auth/passkey/login/options",
  passkeyLoginVerify: "/api/auth/passkey/login/verify",
  logout: "/api/auth/logout",
  enrollmentStart: "/api/auth/enrollment/start",
  enrollmentTotpStart: "/api/auth/enrollment/totp/start",
  enrollmentTotpVerify: "/api/auth/enrollment/totp/verify",
  enrollmentPasskeyOptions: "/api/auth/enrollment/passkey/options",
  enrollmentPasskeyVerify: "/api/auth/enrollment/passkey/verify",
  recoveryStart: "/api/auth/recovery/start",
  security: "/api/auth/security",
  securityPasskeyOptions: "/api/auth/security/passkey/options",
  securityPasskeyVerify: "/api/auth/security/passkey/verify",
  securityPasskeyRemove: "/api/auth/security/passkey/remove",
  securityTotpStart: "/api/auth/security/totp/start",
  securityTotpVerify: "/api/auth/security/totp/verify",
  securitySessionsRevoke: "/api/auth/security/sessions/revoke",
} as const;
