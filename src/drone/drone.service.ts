import {
	Injectable,
	NotFoundException,
	BadRequestException,
	Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Drone, DroneState } from './drone.entity';
import { AuditLog } from './audit-log.entity';
import { AuditEventType } from './audit-log.entity';
import { CreateDroneDto } from './dto/create-drone.dto';
import { FindDroneDto } from './dto/find-drone.dto';
import { LoadDroneDto } from './dto/load-drone.dto';
import { Medication } from '../medication/medication.entity';
import { MedicationService } from '../medication/medication.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UpdateDroneDto } from './dto/update-drone.dto';

@Injectable()
export class DroneService {
	constructor(
		@InjectRepository(Drone)
		private readonly droneRepo: Repository<Drone>,
		@InjectRepository(AuditLog)
		private readonly auditRepo: Repository<AuditLog>,
		@Inject(MedicationService)
		private readonly medService: MedicationService,
	) {}

	async registerDrone(dto: CreateDroneDto): Promise<Drone> {
		const drone = this.droneRepo.create({ ...dto, state: DroneState.IDLE });
		const saved = await this.droneRepo.save(drone);
		await this.auditRepo.save({
			drone: saved,
			eventType: AuditEventType.STATE_CHANGE,
			metadata: { toState: DroneState.IDLE },
		});
		return saved;
	}

	async find(filter: FindDroneDto): Promise<{ data: Drone[]; meta: any }> {
		const qb = this.droneRepo.createQueryBuilder('drone');

		if (filter.state === 'available') {
			qb.andWhere(
				'drone.state = :idle AND drone.batteryCapacity >= :min',
				{
					idle: DroneState.IDLE,
					min: 25,
				},
			);
		} else if (filter.state) {
			qb.andWhere('drone.state = :state', { state: filter.state });
		}

		if (filter.model) {
			qb.andWhere('drone.model = :model', { model: filter.model });
		}

		const total = await qb.getCount();
		const page = filter.page || 1;
		const limit = filter.limit || 10;
		const offset = (page - 1) * limit;

		qb.skip(offset).take(limit);

		const data = await qb.getMany();
		const totalPages = Math.ceil(total / limit);
		const hasNextPage = page < totalPages;
		const hasPrevPage = page > 1;

		return {
			data,
			meta: {
				page,
				limit,
				total,
				totalPages,
				hasNextPage,
				hasPrevPage,
			},
		};
	}

	async findOne(id: string): Promise<Drone> {
		const drone = await this.droneRepo.findOne({
			where: { id },
			relations: ['medications'],
		});
		if (!drone) throw new NotFoundException(`Drone ${id} not found`);
		return drone;
	}

	async update(id: string, updateDto: UpdateDroneDto): Promise<Drone> {
		const drone = await this.droneRepo.findOne({ where: { id } });
		if (!drone) throw new NotFoundException(`Drone ${id} not found`);
		if (updateDto?.state === DroneState.DELIVERING)
			return this.initiateDelivery(drone);
		if (updateDto?.state === DroneState.DELIVERED)
			return this.completeDelivery(drone);
		if (updateDto?.state === 'returned') return this.completeReturn(drone);
		if (typeof updateDto?.batteryCapacity === 'number') {
			drone.batteryCapacity = updateDto.batteryCapacity;
			return this.droneRepo.save(drone);
		}
		return drone;
	}

	async findBatteryLevel(id: string): Promise<number> {
		const drone = await this.findOne(id);
		return drone.batteryCapacity;
	}

	private async recordStateChange(
		drone: Drone,
		nextState: DroneState,
	): Promise<Drone> {
		await this.auditRepo.save({
			drone,
			eventType: AuditEventType.STATE_CHANGE,
			metadata: { from: drone.state, to: nextState },
		});
		drone.state = nextState;
		return this.droneRepo.save(drone);
	}

	private async initiateDelivery(drone: Drone): Promise<Drone> {
		if (drone.state !== DroneState.LOADED) {
			throw new BadRequestException(`Drone ${drone.id} is not loaded`);
		}
		return this.recordStateChange(drone, DroneState.DELIVERING);
	}

	private async completeDelivery(drone: Drone): Promise<Drone> {
		if (drone.state !== DroneState.DELIVERING) {
			throw new BadRequestException(
				`Drone ${drone.id} is not delivering`,
			);
		}
		await this.recordStateChange(drone, DroneState.DELIVERED);
		drone.medications = [];
		return this.recordStateChange(drone, DroneState.RETURNING);
	}

	private async completeReturn(drone: Drone): Promise<Drone> {
		if (drone.state !== DroneState.RETURNING) {
			throw new BadRequestException(`Drone ${drone.id} is not returning`);
		}
		return this.recordStateChange(drone, DroneState.IDLE);
	}

	async loadDrone(id: string, loadDto: LoadDroneDto): Promise<Drone> {
		const drone = await this.droneRepo.findOne({
			where: { id },
			relations: ['medications'],
		});
		if (!drone) throw new NotFoundException(`Drone ${id} not found`);
		if (drone.batteryCapacity < 25)
			throw new BadRequestException(`Battery below 25%`);
		if (drone.state !== DroneState.IDLE)
			throw new BadRequestException(`Drone not idle`);

		// Validate the whole load before touching the drone's state, so a
		// rejected load leaves it idle instead of stuck in loading.
		const meds = await this.medService.findByCodes(loadDto.medicationCodes);
		if (meds.length !== loadDto.medicationCodes.length)
			throw new NotFoundException('One or more medications not found');

		const totalWeight = meds.reduce((sum, m) => sum + m.weight, 0);
		if (totalWeight > drone.weightLimit)
			throw new BadRequestException(
				`Weight ${totalWeight} exceeds ${drone.weightLimit}`,
			);

		await this.recordStateChange(drone, DroneState.LOADING);
		drone.medications = meds;
		return this.recordStateChange(drone, DroneState.LOADED);
	}

	@Cron(CronExpression.EVERY_HOUR)
	async handleBatteryAudit() {
		const drones = await this.droneRepo.find();
		const logs = drones.map((d) =>
			this.auditRepo.create({
				drone: d,
				eventType: AuditEventType.BATTERY_CHECK,
				metadata: { batteryLevel: d.batteryCapacity },
			}),
		);
		await this.auditRepo.save(logs);
	}
}
