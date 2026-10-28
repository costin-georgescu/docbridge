import { Inject, Injectable } from "@nestjs/common";
import { ACCESS_TOKEN_TTL_S, SERVICE_TOKEN_TTL_S } from "../constants";
import { SigningKeyService } from "../keys/signing-key.service";

interface TokenUser {
  id: string;
  displayName: string;
  isAdmin: boolean;
}

@Injectable()
export class TokenService {
  constructor(
    @Inject(SigningKeyService)
    private readonly signingKey: SigningKeyService,
  ) {}

  issueUserToken(user: TokenUser, teamIds: string[]): Promise<string> {
    return this.signingKey.sign(
      {
        sub: user.id,
        name: user.displayName,
        teams: teamIds,
        admin: user.isAdmin,
      },
      ACCESS_TOKEN_TTL_S,
    );
  }

  issueServiceToken(clientId: string, scopes: string[]): Promise<string> {
    return this.signingKey.sign(
      { sub: `service:${clientId}`, scope: scopes },
      SERVICE_TOKEN_TTL_S,
    );
  }
}
