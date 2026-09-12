<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * A job is a booked piece of work at an address. It may run over several days:
 * `starts_on` is the first, `ends_on` the last, and `ends_on` is null for the
 * ordinary one-day job — so the absent value and "finishes the day it starts"
 * mean the same thing.
 *
 * Named `fence_jobs` rather than `jobs` because Laravel's queue already owns
 * that table name.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('fence_jobs', function (Blueprint $table) {
            $table->id();
            $table->string('address');
            $table->text('description')->nullable();

            $table->date('starts_on')->nullable()->index();
            $table->date('ends_on')->nullable();
            $table->time('start_time')->nullable();
            // What the customer asked for, independent of the day it is booked
            // on — which is what makes a late booking visible.
            $table->date('due_on')->nullable();

            $table->enum('job_type', ['Delivery', 'Install', 'Service', 'Pickup'])
                ->default('Delivery');

            // Notes for the crew travel with the job; internal notes never do.
            $table->text('notes_driver')->nullable();
            $table->text('notes_internal')->nullable();

            $table->boolean('confirmed')->default(false);
            $table->decimal('lat', 10, 7)->nullable();
            $table->decimal('lng', 10, 7)->nullable();

            $table->timestamps();
            $table->index(['starts_on', 'ends_on']);
        });

        Schema::create('employee_fence_job', function (Blueprint $table) {
            $table->id();
            $table->foreignId('fence_job_id')->constrained()->cascadeOnDelete();
            $table->foreignId('employee_id')->constrained()->cascadeOnDelete();
            $table->timestamps();

            $table->unique(['fence_job_id', 'employee_id']);
        });

        Schema::create('job_folders', function (Blueprint $table) {
            $table->id();
            $table->foreignId('fence_job_id')->constrained()->cascadeOnDelete();
            // Kept as a row of its own so a folder made on purpose and left
            // empty still shows up.
            $table->string('path');
            $table->timestamps();

            $table->unique(['fence_job_id', 'path']);
        });

        Schema::create('job_files', function (Blueprint $table) {
            $table->id();
            $table->foreignId('fence_job_id')->constrained()->cascadeOnDelete();
            $table->string('folder')->default('');
            $table->string('filename');
            $table->string('content_type')->nullable();
            $table->unsignedBigInteger('size_bytes')->default(0);
            // On disk, not in the row: a blob column turns every job listing
            // into a table scan over megabytes it never reads.
            $table->string('storage_path');
            $table->foreignId('uploaded_by')->nullable()
                ->constrained('employees')->nullOnDelete();
            $table->timestamps();

            $table->index(['fence_job_id', 'folder']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('job_files');
        Schema::dropIfExists('job_folders');
        Schema::dropIfExists('employee_fence_job');
        Schema::dropIfExists('fence_jobs');
    }
};
