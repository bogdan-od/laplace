import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ClassesModule } from '../classes/classes.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

@Module({
  imports: [UsersModule, ClassesModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionService],
})
export class AuthModule {}
