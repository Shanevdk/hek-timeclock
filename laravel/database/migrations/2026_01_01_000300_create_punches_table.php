<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * A shift. Paid hours are NOT the raw clock_in -> clock_out span: shop/load
 * time is added and the unpaid lunch is taken off, both entered by the crew at
 * clock-out in quarter-hour steps.
 *
 * Phase 1B makes `fence_job_id` and `cost_code` mandatory at punch-IN, which is
 * the change that lets job costing work at all — hours with no job on them can
 * never be costed afterwards. The column is nullable only so historic punches
 * imported from the Node app can land; new punches are required at the
 * application layer.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('punches', function (Blueprint $table) {
            $table->id();
            $table->foreignId('employee_id')->constrained()->cascadeOnDelete();

            // Restricted, not cascaded: deleting a job must never silently
            // delete the hours somebody was paid for.
            $table->foreignId('fence_job_id')->nullable()
                ->constrained()->restrictOnDelete();
            $table->enum('cost_code', [
                'install', 'tear_out', 'travel', 'shop', 'warranty_callback',
            ])->nullable()->index();

            $table->dateTime('clock_in');
            $table->dateTime('clock_out')->nullable();

            // Quarter-hour adjustments. Stored as minutes so the arithmetic is
            // exact — 0.75 of an hour is not representable as a float.
            $table->unsignedSmallInteger('shop_minutes')->default(0);
            $table->unsignedSmallInteger('lunch_minutes')->default(0);

            // Typed in by the driver, not derived from GPS: location is often
            // off and jobsite addresses aren't always recognised. Tenths of a
            // kilometre, stored as an integer.
            $table->unsignedInteger('km_tenths')->nullable();

            $table->text('work_done')->nullable();
            $table->text('missed_reason')->nullable();
            $table->text('note')->nullable();

            $table->decimal('clock_in_lat', 10, 7)->nullable();
            $table->decimal('clock_in_lng', 10, 7)->nullable();
            // Metres from the job site at punch-in. A warning, never a block —
            // GPS drifts — but it is logged so a pattern is visible.
            $table->unsignedInteger('geofence_metres')->nullable();

            $table->boolean('edited')->default(false);
            $table->timestamps();

            $table->index(['employee_id', 'clock_out']);
            $table->index(['fence_job_id', 'cost_code']);
        });

        // The jobs a crew member ticked off at clock-out, snapshotted. The
        // address is copied because a timesheet must still read correctly after
        // the job it referred to is edited or deleted.
        Schema::create('punch_job_snapshots', function (Blueprint $table) {
            $table->id();
            $table->foreignId('punch_id')->constrained()->cascadeOnDelete();
            $table->foreignId('fence_job_id')->nullable()
                ->constrained()->nullOnDelete();
            $table->string('address');
            $table->text('description')->nullable();
            $table->decimal('lat', 10, 7)->nullable();
            $table->decimal('lng', 10, 7)->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('punch_job_snapshots');
        Schema::dropIfExists('punches');
    }
};
