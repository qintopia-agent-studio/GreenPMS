export const accountManagementActions = [
  "CREATE_STAFF", "RESET_PASSWORD", "CHANGE_PASSWORD", "DISABLE_STAFF",
  "ENABLE_STAFF", "REVOKE_SESSIONS", "DELETE_STAFF", "DELETE_MEMBER"
] as const;
export type AccountManagementAction = (typeof accountManagementActions)[number];

export interface AccountManagementRequest {
  propertyId: string;
  requestId: string;
  action: AccountManagementAction;
  targetId?: string;
  expectedVersion?: string;
  username?: string;
  displayName?: string;
  currentPassword?: string;
  confirmErroneousPayments?: true;
  newPassword?: string;
  confirmation: true;
  reason: string;
}

export interface AccountManagementResult {
  operationId: string;
  action: AccountManagementAction;
  targetId: string;
  displayName: string;
  completedAt: string;
}

export interface StaffAccountDto {
  id: string;
  username: string;
  displayName: string;
  status: "ACTIVE" | "DISABLED";
  version: string;
  lastLoginAt: string | null;
  activeSessions: number;
  canDelete: boolean;
}

export interface AccountManagementContext {
  self: Pick<StaffAccountDto, "id" | "username" | "displayName" | "version">;
  canManageStaff: boolean;
  canDeleteMember: boolean;
  accounts: StaffAccountDto[];
  history: Array<AccountManagementResult & { reason: string; actorName: string }>;
}

export interface MemberDeletionPreview {
  memberId: string;
  fullName: string;
  nickname: string;
  phone: string;
  version: string;
  canDelete: boolean;
  blockedReason: string | null;
  membershipOrderCount: number;
  roomNights: number;
  bedNights: number;
  reversalAmountMinor: number;
}
