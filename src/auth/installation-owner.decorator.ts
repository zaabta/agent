import { SetMetadata } from '@nestjs/common';

export const INSTALLATION_OWNER_ONLY = 'sitepilot.installation-owner-only';
export const InstallationOwnerOnly = () => SetMetadata(INSTALLATION_OWNER_ONLY, true);
