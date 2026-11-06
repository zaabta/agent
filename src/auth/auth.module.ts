import { Global, Module } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { ApiAuthGuard } from './api-auth.guard.js';
import { AuthController } from './auth.controller.js';

@Global()
@Module({ controllers: [AuthController], providers: [AuthService, ApiAuthGuard], exports: [AuthService, ApiAuthGuard] })
export class AuthModule {}
