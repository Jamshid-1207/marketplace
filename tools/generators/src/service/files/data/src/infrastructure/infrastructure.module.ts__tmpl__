import { Global, Module } from '@nestjs/common';
import { ConsumerRunner, KafkaPublisher } from '@repo/kafka';
import { OutboxRelay } from '@repo/outbox';
import { KafkaReadiness, MessagingLifecycle, messagingProviders } from './messaging';
import { DatabaseReadiness, PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, ...messagingProviders, MessagingLifecycle],
  exports: [PrismaService, KafkaPublisher, OutboxRelay, ConsumerRunner],
})
export class InfrastructureModule {}

/** Проверки для `/health/ready` (SD-01, п. 6.2). */
export const readinessChecks = [DatabaseReadiness, KafkaReadiness];
