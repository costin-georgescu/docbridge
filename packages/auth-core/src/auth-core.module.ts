import {
  DynamicModule,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { AuthGuard } from "./auth.guard";
import { JwksClient, JwksClientOptions } from "./jwks-client";
import { TokenVerifier } from "./token-verifier";

@Injectable()
class JwksWarmUp implements OnApplicationBootstrap {
  private readonly logger = new Logger(JwksClient.name);

  constructor(@Inject(JwksClient) private readonly jwks: JwksClient) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jwks.warmUp();
    } catch (err) {
      this.logger.warn(
        `JWKS warm-up failed; keys will be fetched lazily: ${err}`,
      );
    }
  }
}

@Global()
@Module({})
export class AuthCoreModule {
  static forRoot(options: JwksClientOptions): DynamicModule {
    return {
      module: AuthCoreModule,
      providers: [
        { provide: JwksClient, useFactory: () => new JwksClient(options) },
        TokenVerifier,
        AuthGuard,
        JwksWarmUp,
      ],
      exports: [JwksClient, TokenVerifier, AuthGuard],
    };
  }
}
