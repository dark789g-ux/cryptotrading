import { SetMetadata } from '@nestjs/common';
import { AUTH_ADMIN_ONLY_KEY } from '../auth.constants';

export const AdminOnly = () => SetMetadata(AUTH_ADMIN_ONLY_KEY, true);
