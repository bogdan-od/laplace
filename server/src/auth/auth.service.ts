import { Injectable } from '@nestjs/common';
import type { Id, Me } from '@shared/api';
import { badRequest, ApiException } from '../common/api-exception';
import { Db } from '../db/db';
import { MembershipService } from '../classes/membership.service';
import {
  burnPasswordCheck,
  hashPassword,
  verifyPassword,
} from '../users/password';
import { toMe, UsersService } from '../users/users.service';
import { AuthUser } from './auth.types';
import { LoginDto, PatchMeDto, RegisterDto } from './dto';
import { SessionService } from './session.service';

export interface LoggedIn {
  me: Me;
  /** Cookie value. */
  token: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly users: UsersService,
    private readonly sessions: SessionService,
    private readonly membership: MembershipService,
  ) {}

  /** A student joins the class of the invite code in the same transaction as the account. */
  async register(dto: RegisterDto): Promise<LoggedIn> {
    if (dto.role === 'teacher' && dto.invite_code) {
      throw badRequest(
        'Викладач реєструється без коду запрошення',
        'bad_invite',
      );
    }
    const passwordHash = await hashPassword(dto.password);
    const id = this.db.tx(() => {
      const classId =
        dto.role === 'student'
          ? this.membership.requireClassByInvite(dto.invite_code)
          : null;
      const userId = this.users.create({
        login: dto.login,
        name: dto.name,
        role: dto.role,
        passwordHash,
      });
      if (classId !== null)
        this.membership.joinAsStudent(classId, { id: userId });
      return userId;
    });
    return this.startSession(id);
  }

  async login(dto: LoginDto): Promise<LoggedIn> {
    const user = this.users.byLogin(dto.login);
    if (!user) {
      await burnPasswordCheck(dto.password);
      throw invalidCredentials();
    }
    if (!(await verifyPassword(dto.password, user.password_hash))) {
      throw invalidCredentials();
    }
    return this.startSession(user.id);
  }

  async patchMe(user: AuthUser, token: unknown, dto: PatchMeDto): Promise<Me> {
    if (dto.password) {
      const row = this.users.byId(user.id);
      if (
        !row ||
        !(await verifyPassword(dto.password.old, row.password_hash))
      ) {
        throw badRequest('Поточний пароль введено неправильно');
      }
      this.users.setPasswordHash(user.id, await hashPassword(dto.password.new));
      this.sessions.destroyOthers(user.id, token);
    }
    if (dto.name !== undefined) this.users.rename(user.id, dto.name);
    return this.me(user.id);
  }

  me(id: Id): Me {
    const row = this.users.byId(id);
    if (!row) throw new ApiException(401, 'Потрібно увійти', 'not_logged_in');
    return toMe(row);
  }

  private startSession(userId: Id): LoggedIn {
    return { me: this.me(userId), token: this.sessions.create(userId) };
  }
}

const invalidCredentials = (): ApiException =>
  new ApiException(401, 'Неправильний логін або пароль');
