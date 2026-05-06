import { SetMetadata } from '@nestjs/common';
import { AUTH_PUBLIC_KEY } from '../shared/auth.constants';

export const Public = () => SetMetadata(AUTH_PUBLIC_KEY, true);
